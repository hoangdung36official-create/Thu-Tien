import { createHash, randomUUID } from 'node:crypto';

export const SHEET_NAMES = ['NHẬP CẦN THU', 'CẦN THU', 'NHẬT KÝ', 'CÀI ĐẶT', 'TÀI KHOẢN NHẬN', 'PHÂN QUYỀN WEBAPP', 'KIỂM SOÁT WEBAPP'] as const;
export const JOURNAL_HEADERS = ['Ngày thu','Tháng','Mã nhà','Phòng','Người thu','Tài khoản nhận','Tiền thu','Hình thức','Người nộp','Ghi chú','Mã giao dịch','Ngày chuyển khoản','Nội dung chuyển khoản'];

export const clean = (v: unknown) => String(v ?? '').trim();
export const key = (v: unknown) => clean(v).normalize('NFC').toUpperCase();
export function vnd(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  const text = clean(value);
  if (!/^-?\d+$/.test(text)) throw new Error('Số tiền phải là số nguyên VND');
  return BigInt(text);
}
export function safeNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Tổng số tiền vượt giới hạn hiển thị');
  return Number(value);
}
export function sum(values: bigint[]) { return values.reduce((s, n) => s + n, 0n); }
export function monthValid(month: string) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(month); }
export function parseDate(value: unknown, required = false): Date | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error('Thiếu ngày chuyển khoản');
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Google Sheets date serial (1899-12-30), use UTC to avoid server timezone differences.
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
  }
  const raw = clean(value);
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m && !iso) throw new Error('Ngày phải theo dd/MM/yyyy');
  const [y, mon, d] = m ? [Number(m[3]),Number(m[2]),Number(m[1])] : [Number(iso![1]),Number(iso![2]),Number(iso![3])];
  const date = new Date(Date.UTC(y, mon - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mon - 1 || date.getUTCDate() !== d) throw new Error('Ngày không tồn tại');
  return date;
}
export function monthFromSheet(value: unknown): string | null {
  try {
    const d = parseDate(value);
    return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}` : null;
  } catch { return null; }
}
export function dayText(value: Date | null | undefined): string {
  if (!value) return '';
  return `${String(value.getUTCDate()).padStart(2,'0')}/${String(value.getUTCMonth()+1).padStart(2,'0')}/${value.getUTCFullYear()}`;
}
export function serial(date: Date | null | undefined): number | string { return date ? Math.round((date.getTime()-Date.UTC(1899,11,30))/86400000) : ''; }
export function fromSheetAmount(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Tiền trong Google Sheets không phải số nguyên hợp lệ');
    return BigInt(value);
  }
  const compact = clean(value).replace(/[,.\s₫đ]/g, '');
  return compact ? vnd(compact) : 0n;
}
export function fingerprint(row: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(Array.from({length:13},(_,i)=>row[i] ?? ''))).digest('hex');
}
export function pendingRemoteHasConflict(remoteFingerprint:string|null, baselineFingerprint:string|null, sameValues:boolean):boolean {
  // If a previous write succeeded but acknowledgement failed, its values may
  // match even though the local baseline is stale. Accept that safe retry.
  // Removing a remote record previously known to exist is also a conflict;
  // a brand-new local record with no remote baseline can still be appended.
  if (sameValues) return false;
  return remoteFingerprint===null ? baselineFingerprint!==null
    : baselineFingerprint!==remoteFingerprint;
}
export const catalogHasConflict = pendingRemoteHasConflict;
export type DueRow = {month:string;houseCode:string;room:string;amount:bigint;sheetRow:number;sheetColumn:number};
export function readDues(rows: unknown[][]): {months: string[]; dues: DueRow[] } {
  const headers = rows[0] || [];
  const positions = headers.map((v,i)=>({month:monthFromSheet(v),index:i})).filter(x=>x.index>=4 && x.month) as {month:string;index:number}[];
  if (!positions.length) throw new Error('NHẬP CẦN THU không có cột tháng từ E1');
  const months=positions.map(p=>p.month);
  if(new Set(months).size!==months.length) throw new Error('NHẬP CẦN THU có hai cột cùng tháng; cần sửa tiêu đề');
  const seen = new Set<string>();
  const rooms = new Set<string>();
  const dues: DueRow[] = [];
  for (let i=1;i<rows.length;i++) {
    const row=rows[i],room=clean(row[1]),house=key(row[2]);
    if (!room || !house) continue;
    const roomId=`${house}|${room}`;
    if(rooms.has(roomId)) throw new Error(`Trùng phòng trong NHẬP CẦN THU: ${roomId}`);
    rooms.add(roomId);
    for (const p of positions) {
      const amount=fromSheetAmount(row[p.index]);
      if(amount<0n)throw new Error(`Số cần thu âm ở ${roomId}, tháng ${p.month}`);
      if (amount === 0n) continue;
      const id=`${p.month}|${house}|${room}`;
      if (seen.has(id)) throw new Error(`Trùng phòng/tháng trong NHẬP CẦN THU: ${id}`);
      seen.add(id);
      dues.push({month:p.month,houseCode:house,room,amount,sheetRow:i+1,sheetColumn:p.index+1});
    }
  }
  // Empty/truncated API responses must not atomically erase the imported dues.
  if(!rooms.size || !dues.length) throw new Error('NHẬP CẦN THU không có khoản phải thu hợp lệ; giữ dữ liệu cũ để kiểm tra');
  return {months:months.sort().reverse(),dues};
}
export type JournalRow = {
  id:string;month:string;houseCode:string;room:string;collector:string;payer:string;amount:bigint;
  method:string;accountName:string|null;receivedAt:Date;transferAt:Date|null;transferMemo:string;note:string;
  sheetRow:number;sheetFingerprint:string;isLegacy:boolean;
};
export function readJournal(row: unknown[], number: number, sheetId: string): JournalRow | null {
  if (!row.some(v => clean(v))) return null;
  const month=monthFromSheet(row[1]),house=key(row[2]),room=clean(row[3]);
  if (!month || !house || !room || !clean(row[6])) return null;
  const amount=fromSheetAmount(row[6]);
  if (amount <= 0n) return null;
  const existing=clean(row[10]);
  const isLegacy=!existing;
  // Unknown legacy records are locally read-only; row content + sheet ID are evidence.
  const id=existing||`LEGACY-${createHash('sha256').update(sheetId+'|'+number+'|'+fingerprint(row)).digest('hex').slice(0,32)}`;
  const method=key(row[7])==='CHUYỂN KHOẢN'?'Chuyển khoản':'Tiền mặt';
  if(!clean(row[0])) throw new Error(`NHẬT KÝ dòng ${number} thiếu ngày thu`);
  return {id,month,houseCode:house,room,collector:clean(row[4]),payer:clean(row[8]),amount,method,
    accountName:method==='Chuyển khoản'?clean(row[5])||null:null,receivedAt:parseDate(row[0])!,
    transferAt:parseDate(row[11]),transferMemo:clean(row[12]),note:clean(row[9]),sheetRow:number,
    sheetFingerprint:fingerprint(row),isLegacy};
}
// Keep the physical row index even when one legacy/hand-edited row is invalid.
// The sync layer uses the raw nonempty row to raise a conflict and will not
// infer any remote deletions from a partially unparseable journal.
export function readJournalSafely(row: unknown[], number: number, sheetId: string): JournalRow | null {
  try { return readJournal(row, number, sheetId); }
  catch { return null; }
}
export function journalValues(v: {id:string;month:string;houseCode:string;room:string;collector:string;accountName:string|null;
    amount:bigint;method:string;payer:string;note:string;receivedAt:Date;transferAt:Date|null;transferMemo:string}): (string|number)[] {
  return [serial(v.receivedAt),serial(parseDate(v.month+'-01')),
    v.houseCode,/^\d+$/.test(v.room)?Number(v.room):v.room,v.collector,v.accountName||'',safeNumber(v.amount),
    v.method,v.payer,v.note,v.id,serial(v.transferAt),v.transferMemo];
}
export function newReceiptId() { return `VW-${randomUUID()}`; }
export function checkAmount(amount: bigint, remaining: bigint) {
  if (amount <= 0n || amount > 1000000000n || amount > remaining) throw new Error('Số tiền phải > 0 và không vượt số còn phải thu (tối đa 1 tỷ/giao dịch)');
}
export function balance(due:bigint, paid:bigint) { return due > paid ? due - paid : 0n; }
export function safeSheetText(value: string) {
  const cleaned=value.replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}
