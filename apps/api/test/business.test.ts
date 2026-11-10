import assert from 'node:assert/strict';
import test from 'node:test';
import { readDues,readJournal,readJournalSafely,checkAmount,parseDate,dayText,journalValues,fingerprint,balance,catalogHasConflict,pendingRemoteHasConflict } from '../src/business.js';

test('NHẬP CẦN THU: lấy đúng tháng tại E+, B=phòng C=nhà',()=>{
  const result=readDues([[null,null,null,null,46266,46236],[null,203,'V1',null,3500000,2800000],[null,'101','V2',null,2100000,0]]);
  assert.equal(result.dues.length,3);
  assert.equal(result.dues[0].room,'203');
  assert.equal(result.dues[0].houseCode,'V1');
  assert.equal(result.dues[0].amount,3500000n);
  assert.equal(result.dues[0].sheetColumn,5);
});
test('phát hiện trùng cùng tháng, nhà, phòng',()=>{
  assert.throws(()=>readDues([[null,null,null,null,'01/11/2026'],[null,101,'V1',null,100],[null,101,'V1',null,200]]),/Trùng phòng/);
});
test('từ chối snapshot NHẬP CẦN THU rỗng hoặc chỉ toàn số không',()=>{
  const header=[null,null,null,null,'01/11/2026'];
  assert.throws(()=>readDues([header]),/không có khoản phải thu hợp lệ/);
  assert.throws(()=>readDues([header,[null,101,'V1',null,0]]),/không có khoản phải thu hợp lệ/);
});
test('từ chối cột tháng trùng và số tiền cần thu âm',()=>{
  assert.throws(()=>readDues([[null,null,null,null,'01/11/2026','01/11/2026'],[null,101,'V1',null,100,300]]),/hai cột cùng tháng/);
  assert.throws(()=>readDues([[null,null,null,null,'01/11/2026'],[null,101,'V1',null,-100]]),/Số cần thu âm/);
});
test('phát hiện phòng bị lặp dù dòng thứ hai có số tiền bằng 0',()=>{
  assert.throws(()=>readDues([[null,null,null,null,'01/11/2026'],[null,101,'V1',null,100],[null,101,'V1',null,0]]),/Trùng phòng/);
});
test('đọc và ghi NHẬT KÝ đúng A:M, tách ngày thu và chuyển khoản',()=>{
  const row=[46322,46266,'V1',203,'An','VCB',200000,'Chuyển khoản','Nguyễn A','','VW-11111111-1111-4111-8111-111111111111',46320,'Tiền phòng'];
  const receipt=readJournal(row,5,'SHEET-1')!;
  assert.equal(receipt.id,row[10]);
  assert.equal(receipt.transferMemo,'Tiền phòng');
  assert.equal(receipt.sheetFingerprint,fingerprint(row));
  assert.deepEqual(journalValues(receipt),row);
});
test('kiểm tra ngày nhuận, nhập sai ngày và công nợ',()=>{
  assert.equal(dayText(parseDate('29/02/2024')),'29/02/2024');
  assert.throws(()=>parseDate('29/02/2025'),/không tồn tại/);
  checkAmount(250n);
  checkAmount(200n);
  assert.throws(()=>checkAmount(0n),/> 0/);
  assert.throws(()=>checkAmount(-1n),/> 0/);
  assert.throws(()=>checkAmount(1000000001n),/1 tỷ/);
  assert.equal(balance(200n,120n),80n);
  assert.equal(balance(200n,300n),0n);
});
test('legacy không có mã K có ID nội bộ riêng theo bảng/dòng',()=>{
  const a=readJournal(['01/11/2026','01/11/2026','V1','101','X','',100,'Tiền mặt','','','','',''],2,'COPY')!;
  assert.match(a.id,/^LEGACY-/);
  assert.notEqual(a.id,readJournal(['01/11/2026','01/11/2026','V1','101','X','',100,'Tiền mặt','','','','',''],3,'COPY')?.id);
});

test('dòng NHẬT KÝ sai ngày/số tiền không làm dừng toàn bộ bản chụp',()=>{
  const valid=['01/11/2026','01/11/2026','V1','101','An','',100,'Tiền mặt','','','VW-11111111-1111-4111-8111-111111111111','',''];
  const invalidDate=[...valid];invalidDate[0]='31/02/2026';
  const invalidAmount=[...valid];invalidAmount[6]='một triệu';
  assert.throws(()=>readJournal(invalidDate,3,'SHEET-A'),/Ngày không tồn tại/);
  assert.throws(()=>readJournal(invalidAmount,4,'SHEET-A'),/Số tiền/);
  assert.equal(readJournalSafely(invalidDate,3,'SHEET-A'),null);
  assert.equal(readJournalSafely(invalidAmount,4,'SHEET-A'),null);
  assert.equal(readJournalSafely(valid,5,'SHEET-A')?.sheetRow,5);
});

test('dòng NHẬT KÝ thiếu ngày thu không được tự gán ngày giả',()=>{
  const row=['','01/11/2026','V1','101','An','',100,'Tiền mặt','','','VW-11111111-1111-4111-8111-111111111111','',''];
  assert.throws(()=>readJournal(row,7,'SHEET-A'),/thiếu ngày thu/);
  assert.equal(readJournalSafely(row,7,'SHEET-A'),null);
});

test('retry danh mục: giá trị đã khớp không báo xung đột do fingerprint cũ',()=>{
  assert.equal(catalogHasConflict('remote-new','old',true),false);
  assert.equal(catalogHasConflict('remote-new',null,true),false);
  assert.equal(catalogHasConflict('remote-new','old',false),true);
  assert.equal(catalogHasConflict('remote-new',null,false),true);
  assert.equal(catalogHasConflict('same','same',false),false);
  assert.equal(catalogHasConflict(null,'old',false),true);
  assert.equal(catalogHasConflict(null,null,false),false);
});
test('giao dịch chờ đồng bộ chỉ xung đột nếu Sheets đổi khỏi bản gốc',()=>{
  assert.equal(pendingRemoteHasConflict('baseline','baseline',false),false);
  assert.equal(pendingRemoteHasConflict('changed','baseline',false),true);
  assert.equal(pendingRemoteHasConflict('remote',null,false),true);
  assert.equal(pendingRemoteHasConflict('changed','baseline',true),false);
  assert.equal(pendingRemoteHasConflict(null,'baseline',false),true);
});
