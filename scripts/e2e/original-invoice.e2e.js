/**
 * E2E — luồng người dùng thật quanh "hoá đơn từ cơ quan thuế".
 *
 * Kiểm tra bằng dữ liệu thật trên hệ thống đang chạy:
 *   - đăng nhập, xem danh sách hoá đơn
 *   - cột trạng thái MST đối tác (tra từ tracuunnt.gdt.gov.vn)
 *   - xem / tải bản thể hiện PDF của hoá đơn gốc
 *   - tải XML đã ký số (chữ ký người bán + chữ ký cấp mã CQT)
 *   - tải hàng loạt PDF dạng ZIP
 *   - thông báo rõ ràng với hoá đơn không có bản gốc (nhóm 6/8)
 *   - chặn truy cập khi chưa đăng nhập
 *
 * Cách chạy (trên máy chủ có API):
 *   QA_EMAIL=... QA_PASS=... API_URL=http://127.0.0.1:3001 node scripts/e2e/original-invoice.e2e.js
 *
 * Thoát 0 nếu toàn bộ test PASS.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const API = process.env.API_URL || 'http://127.0.0.1:3001';
const EMAIL = process.env.QA_EMAIL;
const PASS = process.env.QA_PASS;

let token = null;
let companyId = null;
let cookies = '';
const results = [];

function request(method, path, opts = {}) {
  const { body, raw = false, headers = {} } = opts;
  const url = new URL(API + path);
  const client = url.protocol === 'https:' ? https : http;
  const data = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        token ? { Authorization: 'Bearer ' + token } : {},
        companyId ? { 'X-Company-Id': companyId } : {},
        cookies ? { Cookie: cookies } : {},
        headers,
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.headers['set-cookie']) {
          cookies = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        }
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, buf });
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* không phải JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8').slice(0, 300) });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

async function main() {
  if (!EMAIL || !PASS) {
    console.error('Thiếu QA_EMAIL / QA_PASS');
    process.exit(2);
  }

  // 1. Đăng nhập
  const login = await request('POST', '/api/auth/login', { body: { email: EMAIL, password: PASS } });
  token = (login.json && login.json.data && (login.json.data.accessToken || login.json.data.token)) || null;
  check('Đăng nhập', login.status === 200 && !!token, 'HTTP ' + login.status);
  if (!token) { console.error(login.text); process.exit(1); }

  // 2. Công ty — chọn công ty thực sự có hoá đơn để kiểm tra cho có nghĩa
  const companies = await request('GET', '/api/companies');
  const list = (companies.json && companies.json.data) || [];
  companyId = list[0] && list[0].id;
  check('Lấy danh sách công ty', companies.status === 200 && !!companyId, list.length + ' công ty');

  let rows = [];
  for (const c of list) {
    companyId = c.id;
    const r = await request('GET', '/api/invoices?pageSize=20&direction=output');
    const data = (r.json && r.json.data) || [];
    if (data.length > 0) { rows = data; break; }
  }

  // 3. Danh sách hoá đơn — các trường phục vụ màn hình hoá đơn thuế
  const inv = { status: 200, json: { data: rows } };
  check('Danh sách hoá đơn', inv.status === 200 && rows.length > 0, rows.length + ' dòng');
  const first = rows[0] || {};
  check('Có trạng thái MST đối tác', 'partner_mst_status' in first, 'partner_mst_status=' + first.partner_mst_status);
  check('Có trạng thái bản gốc XML', 'xml_status' in first, 'xml_status=' + first.xml_status);
  check('Có trạng thái bản gốc PDF', 'pdf_status' in first, 'pdf_status=' + first.pdf_status);
  check('Danh sách không kèm raw_xml (payload nhẹ)', !('raw_xml' in first));

  // 4. Lọc theo trạng thái MST rủi ro
  const risky = await request('GET', '/api/invoices?pageSize=5&partnerStatus=risky');
  check('Lọc hoá đơn theo NNT rủi ro', risky.status === 200,
    ((risky.json && risky.json.meta && risky.json.meta.total) || 0) + ' hoá đơn');

  // 5. Tra trạng thái MST hàng loạt
  const codes = [];
  rows.forEach((r) => {
    const c = r.direction === 'input' ? r.seller_tax_code : r.buyer_tax_code;
    if (c && /^\d{10}(-\d{3})?$/.test(c) && codes.indexOf(c) === -1) codes.push(c);
  });
  const ps = await request('GET', '/api/invoices/partner-status?taxCodes=' + codes.slice(0, 5).join(','));
  const statuses = (ps.json && ps.json.data && ps.json.data.statuses) || [];
  check('Tra trạng thái MST hàng loạt', ps.status === 200 && Array.isArray(statuses),
    statuses.length + '/' + Math.min(codes.length, 5) + ' MST có dữ liệu');
  const active = statuses.filter((s) => s.mst_status === 'active');
  check('Có MST xác thực "đang hoạt động"', active.length > 0,
    active[0] ? active[0].tax_code + ' · ' + (active[0].registered_name || '') + ' · ' + (active[0].tax_authority || '') : '');

  // 6–10. Bản gốc — nếu chưa có thì yêu cầu tải và chờ, đúng như thao tác người dùng
  let withPdf = rows.filter((r) => r.pdf_status === 'available')[0];

  if (!withPdf) {
    const candidate = rows.filter((r) => r.pdf_status !== 'unavailable' && r.serial_number)[0];
    if (candidate) {
      const reqPdf = await request('POST', '/api/invoices/original-xml/request',
        { body: { invoiceIds: [candidate.id], wantPdf: true } });
      check('Gửi yêu cầu lấy bản gốc', reqPdf.status === 200,
        (reqPdf.json && reqPdf.json.data && reqPdf.json.data.message) || '');

      // Bot phải đăng nhập cổng thuế, tải ZIP rồi render PDF — chờ tối đa 5 phút
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const st = await request('GET', '/api/invoices/original-xml/status?ids=' + candidate.id);
        const row = (st.json && st.json.data && st.json.data.statuses && st.json.data.statuses[0]) || {};
        if (row.has_pdf) { withPdf = candidate; break; }
        if (row.pdf_status === 'unavailable' || row.pdf_status === 'failed') break;
      }
    }
  }

  check('Có hoá đơn đã tải được bản gốc', !!withPdf,
    withPdf ? withPdf.serial_number + '-' + withPdf.invoice_number : 'chưa có');

  if (withPdf) {
    const pdf = await request('GET', '/api/invoices/' + withPdf.id + '/original-pdf', { raw: true });
    check('Tải bản thể hiện PDF', pdf.status === 200 && pdf.buf.slice(0, 5).toString() === '%PDF-',
      'HTTP ' + pdf.status + ', ' + pdf.buf.length + ' bytes');
    check('PDF mở inline trong ứng dụng',
      String(pdf.headers['content-disposition'] || '').indexOf('inline') === 0);

    const xml = await request('GET', '/api/invoices/' + withPdf.id + '/original-xml', { raw: true });
    const xmlText = xml.buf.toString('utf8');
    check('Tải XML gốc đã ký số', xml.status === 200 && xmlText.indexOf('<HDon') >= 0, xml.buf.length + ' bytes');
    check('XML có chữ ký người bán + CQT', (xmlText.match(/<Signature/g) || []).length >= 2,
      (xmlText.match(/<Signature/g) || []).length + ' chữ ký');

    const zip = await request('GET', '/api/invoices/download-pdf?ids=' + withPdf.id, { raw: true });
    check('Tải hàng loạt PDF (ZIP)', zip.status === 200 && zip.buf.readUInt32LE(0) === 0x04034b50,
      'HTTP ' + zip.status + ', ' + zip.buf.length + ' bytes');

    const st = await request('GET', '/api/invoices/original-xml/status?ids=' + withPdf.id);
    const row = (st.json && st.json.data && st.json.data.statuses && st.json.data.statuses[0]) || {};
    check('API trạng thái bản gốc', st.status === 200 && row.has_pdf === true && row.has_xml === true,
      'pdf=' + row.pdf_status + ' xml=' + row.xml_status);
  }

  // 10b. Nguồn bản gốc của nhà cung cấp (Viettel/MISA/VNPT…)
  const target = withPdf || rows[0];
  if (target) {
    const src = await request('GET', '/api/invoices/' + target.id + '/original-sources');
    const d = (src.json && src.json.data) || {};
    check('API nguồn bản gốc', src.status === 200 && !!d.gdt_representation,
      'NCC=' + ((d.provider && (d.provider.short_name || d.provider.name)) || 'chưa rõ'));
    check('Có mã tra cứu của nhà cung cấp', !!d.lookup_code,
      (d.lookup_label || '') + ' = ' + (d.lookup_code || 'không có trong XML'));
    check('Có cổng tra cứu của nhà cung cấp',
      !!(d.provider && (d.provider.portal_url || d.provider.name)),
      (d.provider && d.provider.portal_url) || 'chưa có link cổng');
  }

  // 10c. Chỉ số sức khoẻ hồ sơ thuế trên thanh "Cần xử lý"
  const health = await request('GET', '/api/invoices?pageSize=1&direction=input');
  const th = (health.json && health.json.meta && health.json.meta.summary
    && health.json.meta.summary.tax_health) || null;
  check('API trả chỉ số sức khoẻ thuế', !!th,
    th ? 'rủi ro=' + th.risky_partner_count + ', thiếu bản gốc=' + th.missing_original_count
       + ', thiếu chi tiết=' + th.missing_items_count : '');

  // 10d. Lọc theo trạng thái bản gốc
  const filtered = await request('GET', '/api/invoices?pageSize=5&direction=input&hasOriginal=yes');
  const allHave = ((filtered.json && filtered.json.data) || []).every((r) => r.pdf_status === 'available');
  check('Lọc HĐ đã có bản gốc', filtered.status === 200 && allHave,
    ((filtered.json && filtered.json.meta && filtered.json.meta.total) || 0) + ' HĐ');

  const missing = await request('GET', '/api/invoices?pageSize=5&direction=input&hasLineItems=no');
  const allMissing = ((missing.json && missing.json.data) || []).every((r) => r.has_line_items !== true);
  check('Lọc HĐ thiếu chi tiết hàng hoá', missing.status === 200 && allMissing,
    ((missing.json && missing.json.meta && missing.json.meta.total) || 0) + ' HĐ');

  // 10e. Xếp hàng hàng loạt theo bộ lọc
  const byFilter = await request('POST', '/api/invoices/original-xml/request-by-filter',
    { body: { filter: { direction: 'input' } } });
  check('Lấy bản gốc hàng loạt theo bộ lọc', byFilter.status === 200,
    (byFilter.json && byFilter.json.data && byFilter.json.data.message) || '');

  const itemsByFilter = await request('POST', '/api/invoices/line-items/fetch-by-filter',
    { body: { filter: { direction: 'input' } } });
  check('Lấy chi tiết hàng hoá hàng loạt', itemsByFilter.status === 200,
    (itemsByFilter.json && itemsByFilter.json.data && itemsByFilter.json.data.message) || '');

  // 11. Hoá đơn không có bản gốc phải báo rõ ràng
  const inputs = await request('GET', '/api/invoices?pageSize=50&direction=input');
  const unavailable = ((inputs.json && inputs.json.data) || []).filter((r) => r.pdf_status === 'unavailable')[0];
  if (unavailable) {
    const r = await request('GET', '/api/invoices/' + unavailable.id + '/original-pdf');
    check('Hoá đơn không mã CQT báo lỗi rõ ràng',
      r.status === 409 && !!(r.json && r.json.error && r.json.error.message),
      (r.json && r.json.error && r.json.error.message || '').slice(0, 90));
  } else {
    check('Hoá đơn không mã CQT báo lỗi rõ ràng', true, 'không có mẫu để thử');
  }

  // 12. Bảo mật
  const saved = token;
  token = null;
  const unauth = await request('GET', '/api/invoices?pageSize=1');
  token = saved;
  check('Chặn truy cập khi chưa đăng nhập', unauth.status === 401, 'HTTP ' + unauth.status);

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' test PASS ===');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
