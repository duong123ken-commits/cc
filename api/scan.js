export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const models = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let model = models[0];

  if (!apiKey) {
    return res.status(500).json({
      error: 'Server chưa cấu hình GEMINI_API_KEY trong Environment Variables trên Vercel.'
    });
  }

  try {
    const { base64, mediaType } = req.body || {};
    if (!base64 || !mediaType) {
      return res.status(400).json({ error: 'Thiếu dữ liệu ảnh (base64 hoặc mediaType).' });
    }

    const systemPrompt = `Bạn là hệ thống OCR trích xuất dữ liệu hóa đơn / phiếu giao hàng tiếng Việt.
QUY TẮC BẮT BUỘC:
1. CHỈ trả về duy nhất MỘT object JSON hợp lệ (bắt đầu bằng { và kết thúc bằng }).
2. KHÔNG viết lời giải thích, lời chào, hay khối markdown \`\`\` nào.
3. Cấu trúc object:
{
  "supplier": {"name": "tên người bán / nhà cung cấp", "address": "địa chỉ người bán", "taxCode": "mã số thuế người bán", "phone": "số điện thoại người bán"},
  "customer": "tên người mua / khách hàng",
  "date": "DD/MM/YYYY",
  "items": [{"date": "DD/MM/YYYY", "name": "Tên sản phẩm", "unit": "ĐVT", "qty": 1, "price": 0, "amount": 0}]
}
4. Trường nào không đọc được thì để "" (chuỗi rỗng). "date" trong từng item để "" nếu trùng ngày hóa đơn.
5. Giá trị số (qty, price, amount) là số thuần, không có dấu chấm/phẩy ngăn cách nghìn và không có ký hiệu tiền tệ.
6. Không đưa dòng tổng cộng, thuế, chiết khấu vào "items".`;

    const userPrompt = `Hãy đọc ảnh hóa đơn này và trích xuất thông tin người bán, người mua, ngày hóa đơn và TOÀN BỘ các dòng sản phẩm/dịch vụ theo đúng cấu trúc object JSON đã quy định.
Nếu hóa đơn chỉ ghi thành tiền mà không ghi đơn giá, tự tính price = amount / qty. Chỉ trả về object JSON thuần.`;

    const payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{
        parts: [
          { text: userPrompt },
          { inline_data: { mime_type: mediaType, data: base64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    };

    let response;
    let data = {};
    let lastStatus = 503;
    let lastMessage = 'Gemini đang quá tải';
    const retryable = new Set([408, 429, 500, 502, 503, 504]);
    const deadline = Date.now() + 76000;

    for (let i = 0; i < models.length; i++) {
      model = models[i];
      const remaining = deadline - Date.now();
      if (remaining <= 1000) break;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(i === 0 ? 30000 : 21000, remaining));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      response = undefined;
      data = {};
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        data = await response.json().catch(() => ({}));
        if (response.ok) break;
        lastStatus = response.status;
        lastMessage = data?.error?.message || `HTTP ${lastStatus}`;
        // Do not retry bad credentials or malformed requests. Missing models
        // may be unavailable to this API key, so try the next model.
        if (!retryable.has(lastStatus) && lastStatus !== 404) {
          return res.status(lastStatus).json({ error: `Gemini API lỗi: ${lastMessage}` });
        }
      } catch (err) {
        response = undefined;
        lastStatus = err.name === 'AbortError' ? 504 : 503;
        lastMessage = err.name === 'AbortError' ? 'Gemini phản hồi quá chậm' : 'Không kết nối được Gemini';
      } finally {
        clearTimeout(timeout);
      }
      if (i < models.length - 1 && Date.now() + 1200 < deadline) {
        // A short delay avoids immediately repeating an overloaded request.
        await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 300)));
      }
    }

    if (!response?.ok) {
      return res.status(lastStatus === 404 ? 503 : lastStatus).json({
        error: `Gemini chưa thể quét ảnh (${lastStatus}): ${lastMessage}. Đã thử các model dự phòng; hãy bấm Quét AI để thử lại ảnh lỗi.`
      });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const cleaned = rawText.replace(/```json|```/gi, '').trim();

    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_) {
      const iObj = cleaned.indexOf('{');
      const iArr = cleaned.indexOf('[');
      let start, end;
      if (iArr !== -1 && (iObj === -1 || iArr < iObj)) {
        start = iArr;
        end = cleaned.lastIndexOf(']');
      } else if (iObj !== -1) {
        start = iObj;
        end = cleaned.lastIndexOf('}');
      }
      if (start !== undefined && end > start) {
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1));
        } catch (_) {}
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({
        error: 'AI không trả về JSON hợp lệ',
        rawText: rawText || '(Rỗng)'
      });
    }

    return res.status(200).json({ data: parsed, model });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Lỗi xử lý phía server' });
  }
}
