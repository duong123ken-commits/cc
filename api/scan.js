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
    const { base64, mediaType, retry } = req.body || {};
    const orderedModels = retry === true ? [models[1], models[2], models[0]] : models;
    console.info('[OCR] request started', { bytes: typeof base64 === 'string' ? base64.length : 0, retry: retry === true });
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
  "invoiceTotal": 0,
  "items": [{"date": "DD/MM/YYYY", "name": "Tên sản phẩm", "unit": "ĐVT", "qty": 1, "price": 0, "amount": 0}]
}
4. Trường nào không đọc được thì để "" (chuỗi rỗng). "date" trong từng item để "" nếu trùng ngày hóa đơn.
5. Giá trị số (qty, price, amount) là số thuần, không có dấu chấm/phẩy ngăn cách nghìn và không có ký hiệu tiền tệ.
6. Không đưa dòng tổng cộng, thuế, chiết khấu vào "items".
7. Đọc từng hàng theo STT, đối chiếu đúng cột số lượng, đơn giá, thành tiền; bỏ dấu tick và đường gạch chéo. Không bỏ hàng có chữ viết tay.
8. invoiceTotal là tổng ghi trên giấy, không phải tổng tự tính. Nếu không đọc được để null. Đọc chính xác số liệu trên giấy; việc kiểm tra phép tính sẽ do máy chủ thực hiện. Không tự sửa số rõ ràng để ép khớp tổng.
9. Giữ nguyên tên hàng, quy cách, đơn vị và ngày ở cuối phiếu; không bịa thông tin.
10. Chuẩn hóa tên thương hiệu bánh kẹo khi nhận diện chắc chắn: Dynamite, Nabati (không phải Habati), Chupa Chups, Choco Pie, Oishi, Bento, Milo, Yomost, Lay's, Poca. Viết hoa đúng tên thương hiệu, sửa 'phomai' thành 'phô mai'. Không thêm hãng, vị, trọng lượng hoặc quy cách không nhìn thấy; khi không chắc giữ chữ đọc được.`;

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
    const retryable = new Set([408, 429, 500, 502, 503, 504, 404]);
    const deadline = Date.now() + 45000;

    for (const candidate of orderedModels) {
      model = candidate;
      const remaining = deadline - Date.now();
      if (remaining < 2000) break;
      const controller = new AbortController();
      let timer;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const requestBody = { ...payload, generationConfig: { ...payload.generationConfig,
        ...(model === models[0] ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } };
      response = undefined;
      data = {};
      const started = Date.now();
      try {
        const result = await Promise.race([
          (async () => {
            const upstream = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            });
            return { upstream, json: await upstream.json() };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('OCR_TIMEOUT')); }, Math.min(22000, remaining - 500));
          })
        ]);
        response = result.upstream;
        data = result.json;
        console.info('[OCR] upstream', { model, status: response.status, ms: Date.now() - started });
        if (response.ok && data?.candidates?.[0]?.content?.parts?.some(p => p.text && !p.thought)) break;
        lastStatus = response.ok ? 502 : response.status;
        lastMessage = data?.error?.message || 'Gemini không trả về dữ liệu OCR';
        if (!retryable.has(lastStatus) && !(lastStatus === 400 && /thinking/i.test(lastMessage))) {
          return res.status(lastStatus).json({ error: `Gemini API lỗi: ${lastMessage}` });
        }
        response = undefined;
      } catch (err) {
        response = undefined;
        lastStatus = err.message === 'OCR_TIMEOUT' || err.name === 'AbortError' ? 504 : 503;
        lastMessage = lastStatus === 504 ? 'Gemini phản hồi quá chậm' : 'Không kết nối được Gemini';
        console.warn('[OCR] upstream failure', { model, status: lastStatus, ms: Date.now() - started });
      } finally {
        clearTimeout(timer);
      }
    }

    if (!response?.ok) {
      return res.status(lastStatus === 404 || lastStatus === 400 ? 503 : lastStatus).json({
        error: `Gemini chưa thể quét ảnh (${lastStatus}): ${lastMessage}`
      });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map((p) => p.text || '').join('') || '';
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

    const warnings = [];
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (Array.isArray(items)) {
      let sum = 0;
      let complete = true;
      items.forEach((item, i) => {
        const valid = v => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v));
        if (!valid(item.qty) || !valid(item.price) || !valid(item.amount)) {
          complete = false;
          warnings.push('Dòng ' + (i+1) + ': thiếu số liệu, cần kiểm tra');
          return;
        }
        sum += Number(item.amount);
        if (Math.abs(Number(item.qty)*Number(item.price)-Number(item.amount)) > 1)
          warnings.push('Dòng ' + (i+1) + ': số lượng × đơn giá không khớp thành tiền');
      });
      if (complete && parsed.invoiceTotal != null && parsed.invoiceTotal !== '' && Number(parsed.invoiceTotal)>0 && Math.abs(sum-Number(parsed.invoiceTotal))>1)
        warnings.push('Tổng các dòng ' + sum + ' khác tổng ghi trên phiếu ' + parsed.invoiceTotal);
    }
    return res.status(200).json({ data: parsed, model, warnings });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Lỗi xử lý phía server' });
  }
}
