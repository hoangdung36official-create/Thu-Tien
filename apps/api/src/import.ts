import { readSnapshot } from './sheets.js';
import { pullSnapshot, assertBinding } from './sync.js';
import { db } from './db.js';
import { sum } from './business.js';

const snapshot=await readSnapshot();
const receipts=snapshot.journal.filter((r):r is NonNullable<typeof r>=>!!r);
const counts=new Map<string,number>();
for(const r of receipts)counts.set(r.id,(counts.get(r.id)||0)+1);
const duplicates=[...counts].filter(([,n])=>n>1).map(([id,n])=>({id,rows:n}));
const invalid=snapshot.rawJournal.slice(1).filter((r,i)=>r.some(v=>String(v??'').trim())&&!snapshot.journal[i]).length;
const summary={spreadsheetId:snapshot.spreadsheetId,title:snapshot.title,months:snapshot.months,dues:snapshot.dues.length,
  dueVnd:sum(snapshot.dues.map(d=>d.amount)).toString(),receipts:receipts.length,receiptVnd:sum(receipts.map(r=>r.amount)).toString(),duplicates,invalid};
console.log(JSON.stringify(summary,null,2));
if(process.argv.includes('--commit')){
  if(duplicates.length||invalid)throw new Error('Dữ liệu nguồn có mã K trùng hoặc dòng lỗi; sửa trên Sheet và chạy lại trước khi nhập');
  await assertBinding();
  const before={receipts:await db.receipt.count(),dues:await db.due.count()};
  await pullSnapshot(snapshot);
  const after={receipts:await db.receipt.count(),dues:await db.due.count(),openConflicts:await db.conflict.count({where:{resolved:false}})};
  console.log(JSON.stringify({before,after},null,2));
}else console.log('CHẾ ĐỘ XEM TRƯỚC: chưa ghi PostgreSQL. Dùng --commit khi đã kiểm tra.');
await db.$disconnect();
process.exit(0);
