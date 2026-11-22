export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [
          {
            parts: [
              { text: userPrompt },
              {
                inline_data: {
                  mime_type: mediaType,
                  data: base64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || `HTTP ${response.status}`;
      return res.status(response.status).json({ error: `Gemini API lỗi: ${msg}` });
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
