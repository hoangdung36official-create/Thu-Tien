import { acquireLease, db, keyScope, releaseLease, renewLease } from './db.js';
import { env } from './env.js';
import { catalogHasConflict, pendingRemoteHasConflict, journalValues, readJournal } from './business.js';
import { appendJournal, clearCatalog, deleteJournalRow, readJournalLive, readSnapshot, replaceJournalRow, writeCatalog, type SheetSnapshot } from './sheets.js';
import type { Receipt } from '@prisma/client';

const LOCK=keyScope+'sync-lock';
function spreadsheetId(){
  if(!env.GOOGLE_SPREADSHEET_ID) throw new Error('Google Sheets chưa được cấu hình');
  return env.GOOGLE_SPREADSHEET_ID;
}
function receiptPayload(r:Receipt) {return {
  month:r.month,houseCode:r.houseCode,room:r.room,collector:r.collector,payer:r.payer,amount:r.amount,
  method:r.method,accountName:r.accountName,receivedAt:r.receivedAt,transferAt:r.transferAt,transferMemo:r.transferMemo,note:r.note,
};}
function remotePayload(r:NonNullable<SheetSnapshot['journal'][number]>) {return {
  month:r.month,houseCode:r.houseCode,room:r.room,collector:r.collector,payer:r.payer,amount:r.amount,
  method:r.method,accountName:r.accountName,receivedAt:r.receivedAt,transferAt:r.transferAt,transferMemo:r.transferMemo,note:r.note,
};}
function sameReceipt(a:ReturnType<typeof receiptPayload>,b:ReturnType<typeof remotePayload>) {
  return Object.keys(a).every(k=>{
    const x=(a as any)[k], y=(b as any)[k];
    return (x instanceof Date?x.getTime():x)===(y instanceof Date?y.getTime():y);
  });
}
async function conflict(entityType:string,entityId:string,reason:string,localValue:object|null,sheetValue:object|null,expectedVersion?:number) {
  // A stale sync job must never turn a newer local edit into a conflict.
  if(entityType==='receipt'&&expectedVersion!==undefined){
    const row=await db.receipt.findUnique({where:{id:entityId}});
    if(!row||row.version!==expectedVersion||!['PENDING','FAILED'].includes(row.syncStatus)) return;
  }
  const prior=await db.conflict.findFirst({where:{entityType,entityId,resolved:false}});
  if(!prior) await db.conflict.create({data:{entityType,entityId,reason,
    localValue:localValue?JSON.parse(JSON.stringify(localValue,(_,v)=>typeof v==='bigint'?v.toString():v)):undefined,
    sheetValue:sheetValue?JSON.parse(JSON.stringify(sheetValue,(_,v)=>typeof v==='bigint'?v.toString():v)):undefined}});
  if(entityType==='receipt') await db.receipt.updateMany({where:{id:entityId,...(expectedVersion!==undefined?{version:expectedVersion,syncStatus:{in:['PENDING','FAILED']}}:{})},data:{syncStatus:'CONFLICT'}});
}
export async function assertBinding() {
  const id=spreadsheetId();
  const current=await db.syncState.findUnique({where:{key:'spreadsheetId'}});
  if(current && current.value!==id) throw new Error('Database đã gắn bảng tính khác; cần database riêng cho Spreadsheet ID mới');
  if(!current) await db.syncState.create({data:{key:'spreadsheetId',value:id}}).catch(async(e)=>{
    const now=await db.syncState.findUnique({where:{key:'spreadsheetId'}});
    if(now?.value!==id) throw e;
  });
}

export async function pullSnapshot(s:SheetSnapshot) {
  await assertBinding();
  // NHẬP CẦN THU is authoritative. Replace only the imported dues atomically.
  await db.$transaction(async tx=>{
    await tx.due.deleteMany();
    for(let i=0;i<s.dues.length;i+=500) await tx.due.createMany({data:s.dues.slice(i,i+500)});
    await tx.syncState.upsert({where:{key:'sheetTitle'},create:{key:'sheetTitle',value:s.title},update:{value:s.title}});
    await tx.syncState.upsert({where:{key:'months'},create:{key:'months',value:JSON.stringify(s.months)},update:{value:JSON.stringify(s.months)}});
    await tx.syncState.upsert({where:{key:'dueLastRead'},create:{key:'dueLastRead',value:new Date().toISOString()},update:{value:new Date().toISOString()}});
  },{timeout:120000});
  for(const h of s.houses) {
    const local=await db.house.findUnique({where:{code:h.code}});
    const pending=await db.catalogOutbox.findUnique({where:{key:'house:'+h.code}});
    if(pending && pending.status!=='SYNCED') {
      if(pending.kind==='house-delete') continue;
      const equal=!!local&&local.name===h.name&&local.note===h.note&&local.active===h.active;
      if(catalogHasConflict(h.fingerprint,local?.sheetFingerprint||null,equal))
        await conflict('house',h.code,'Danh mục nhà thay đổi ở cả hai phía',local,h);
      continue;
    }
    if(!h.active){
      await db.$transaction(async tx=>{
        await tx.userHouse.deleteMany({where:{houseCode:h.code}});
        await tx.house.deleteMany({where:{code:h.code}});
        await tx.catalogOutbox.upsert({where:{key:'house:'+h.code},create:{key:'house:'+h.code,kind:'house-delete'},update:{kind:'house-delete',status:'PENDING',attempts:0,error:null}});
      });
      continue;
    }
    await db.house.upsert({where:{code:h.code},create:{code:h.code,name:h.name,note:h.note,active:h.active,sheetFingerprint:h.fingerprint},update:{name:h.name,note:h.note,active:h.active,sheetFingerprint:h.fingerprint}});
  }
  for(const a of s.accounts){
    const local=await db.bankAccount.findUnique({where:{name:a.name}});
    const pending=await db.catalogOutbox.findUnique({where:{key:'account:'+a.name}});
    if(pending && pending.status!=='SYNCED') {
      if(pending.kind==='account-delete') continue;
      const equal=!!local&&local.note===a.note&&local.active===a.active;
      if(catalogHasConflict(a.fingerprint,local?.sheetFingerprint||null,equal))
        await conflict('account',a.name,'Tài khoản nhận thay đổi ở hai phía',local,a);
      continue;
    }
    if(!a.active){
      await db.$transaction(async tx=>{
        await tx.userAccount.deleteMany({where:{accountName:a.name}});
        await tx.bankAccount.deleteMany({where:{name:a.name}});
        await tx.catalogOutbox.upsert({where:{key:'account:'+a.name},create:{key:'account:'+a.name,kind:'account-delete'},update:{kind:'account-delete',status:'PENDING',attempts:0,error:null}});
      });
      continue;
    }
    await db.bankAccount.upsert({where:{name:a.name},create:{name:a.name,note:a.note,active:a.active,sheetFingerprint:a.fingerprint},update:{note:a.note,active:a.active,sheetFingerprint:a.fingerprint}});
  }
  // Imported users require password reset before use. Never copy V6 SHA pepper into new code.
  for(const u of s.users){
    if(!u.login || !u.name) continue;
    const existing=await db.user.findUnique({where:{login:u.login}});
    if(existing) continue;
    await db.user.create({data:{login:u.login,name:u.name,role:u.role,active:u.active,legacySalt:u.legacySalt,legacyHash:u.legacyHash,
      houses:{create:u.houses.map(houseCode=>({houseCode}))},accounts:{create:u.accounts.map(accountName=>({accountName}))}}});
  }
  const ids=new Set<string>();
  let unsafeJournal=false;
  const duplicateIds=new Set<string>();
  for(const row of s.journal) if(row){if(ids.has(row.id))duplicateIds.add(row.id);ids.add(row.id);}
  ids.clear();
  for(let i=0;i<s.journal.length;i++){
    const r=s.journal[i];
    if(!r) {
      const raw=s.rawJournal[i+1]||[];
      if(raw.some(v=>String(v??'').trim())) {unsafeJournal=true;await conflict('invalid-sheet-row',String(i+2),'Không thể đọc dữ liệu NHẬT KÝ',null,{row:raw});}
      continue;
    }
    if(duplicateIds.has(r.id)) {unsafeJournal=true;await conflict('duplicate-sheet-id',r.id,'Trùng mã K trong NHẬT KÝ',null,{row:r.sheetRow});continue;}
    ids.add(r.id);
    const local=await db.receipt.findUnique({where:{id:r.id}});
    if(!local){
      await db.receipt.create({data:{...remotePayload(r),id:r.id,source:r.isLegacy?'LEGACY':'SHEET',status:'ACTIVE',syncStatus:'SYNCED',sheetRow:r.sheetRow,sheetFingerprint:r.sheetFingerprint}});
      continue;
    }
    if(local.syncStatus==='PENDING'||local.syncStatus==='FAILED') {
      // A pending local edit naturally differs from its unchanged remote baseline.
      // Only a changed remote baseline with different values is a real conflict.
      if(pendingRemoteHasConflict(r.sheetFingerprint,local.sheetFingerprint,
          sameReceipt(receiptPayload(local),remotePayload(r))))
        await conflict('receipt',r.id,'Giao dịch bị thay đổi trên Sheet khi còn chờ đồng bộ',receiptPayload(local),remotePayload(r),local.version);
      continue;
    }
    if(local.syncStatus==='CONFLICT') continue;
    if(local.status==='DELETED') {
      await conflict('receipt',r.id,'Giao dịch đã hủy nhưng vẫn còn trên Sheets',receiptPayload(local),remotePayload(r));
      continue;
    }
    if(local.sheetFingerprint!==r.sheetFingerprint||local.sheetRow!==r.sheetRow){
      if(!sameReceipt(receiptPayload(local),remotePayload(r))) {
        await db.$transaction([db.receipt.update({where:{id:r.id},data:{...remotePayload(r),sheetRow:r.sheetRow,sheetFingerprint:r.sheetFingerprint,version:{increment:1}}}),
          db.audit.create({data:{actorLogin:'GOOGLE_SHEETS',action:'SHEET_RECEIPT_EDIT',entityId:r.id,
            before:JSON.parse(JSON.stringify(receiptPayload(local),(_,v)=>typeof v==='bigint'?v.toString():v)),
            after:JSON.parse(JSON.stringify(remotePayload(r),(_,v)=>typeof v==='bigint'?v.toString():v))}})]);
      } else await db.receipt.update({where:{id:r.id},data:{sheetRow:r.sheetRow,sheetFingerprint:r.sheetFingerprint}});
    }
  }
  // An absent financial entry requires explicit reconciliation. Never silently
  // mark a previously acknowledged payment as deleted after a single snapshot.
  if(!unsafeJournal) for(const local of await db.receipt.findMany({where:{syncStatus:'SYNCED',status:'ACTIVE',sheetFingerprint:{not:null}}})){
    if(ids.has(local.id)) continue;
    await conflict('receipt',local.id,'Mã giao dịch đã biến mất khỏi NHẬT KÝ; cần đối soát',receiptPayload(local),null);
  }
  await db.syncState.upsert({where:{key:'lastPull'},create:{key:'lastPull',value:new Date().toISOString()},update:{value:new Date().toISOString()}});
}

export async function flushOutbox(assertLease:()=>void=()=>{}){
  await assertBinding();
  const items=await db.outbox.findMany({where:{status:{in:['PENDING','FAILED']},nextAttemptAt:{lte:new Date()}},take:40,orderBy:{updatedAt:'asc'}});
  for(const job of items){
    assertLease();
    const r=await db.receipt.findUnique({where:{id:job.receiptId}});
    if(!r||r.syncStatus==='CONFLICT'||r.version!==job.version) continue;
    try{
      const rows=await readJournalLive();
      const matches=rows.slice(1).flatMap((row,i)=>String(row[10]??'').trim()===r.id?[{row,i:i+2}]:[]);
      if(matches.length>1) throw new Error('Trùng mã giao dịch K trong Google Sheets');
      const found=matches[0];
      const before=found?readJournal(found.row,found.i,spreadsheetId()):null;
      if(found&&!before) throw new Error('Hàng nguồn có nội dung không đọc được');
      const sameRemote=before?sameReceipt(receiptPayload(r),remotePayload(before)):false;
      // A previous write may have succeeded just before a network failure.
      // An identical remote row is idempotently acknowledged on retry.
      if((r.sheetFingerprint && (!before || before.sheetFingerprint!==r.sheetFingerprint) && !sameRemote &&
          !(r.status==='DELETED'&&!before)) ||
         (!r.sheetFingerprint && before && !sameRemote)) {
        throw new Error('Xung đột: dữ liệu Sheets đã bị sửa hoặc xóa');
      }
      let actualRow:number|null=null,actualFingerprint:string|null=null;
      if(job.operation==='DELETE'||r.status==='DELETED'){
        if(found){
          if(!r.sheetFingerprint) throw new Error('Xung đột: mã giao dịch mới có sẵn ở Sheets');
          const snap=await readSnapshot();
          const latest=await readJournalLive();
          const matching=latest.slice(1).flatMap((row,i)=>String(row[10]??'').trim()===r.id?[{row,i:i+2}]:[]);
          if(matching.length>1) throw new Error('Trùng mã giao dịch K trong Google Sheets');
          if(matching.length){
            const checked=readJournal(matching[0].row,matching[0].i,spreadsheetId());
            if(!checked||(checked.sheetFingerprint!==r.sheetFingerprint&&!sameReceipt(receiptPayload(r),remotePayload(checked))))
              throw new Error('Xung đột: Sheets đã thay đổi trước thao tác xóa');
            assertLease();
            await deleteJournalRow(matching[0].i,snap.tabIds['NHẬT KÝ']);
          }
        }
      } else {
        if(found && sameRemote && before){
          actualRow=found.i;actualFingerprint=before.sheetFingerprint;
        }else{
          // Google Sheets RAW values do not execute formula strings.
          const values=journalValues(r);
          assertLease();
          if(found) await replaceJournalRow(found.i,values);
          else await appendJournal(values);
          const updated=await readJournalLive();
          const actual=updated.slice(1).flatMap((row,i)=>String(row[10]??'').trim()===r.id?[{row,i:i+2}]:[]);
          if(actual.length!==1) throw new Error('Không xác nhận được bản ghi duy nhất sau khi ghi');
          const parsed=readJournal(actual[0].row,actual[0].i,spreadsheetId());
          if(!parsed||!sameReceipt(receiptPayload(r),remotePayload(parsed)))
            throw new Error('Bản ghi sau khi ghi không khớp giao dịch');
          actualRow=actual[0].i;actualFingerprint=parsed.sheetFingerprint;
        }
      }
      // Keep the actual sheet baseline even if another request edited the receipt
      // while Google was processing the previous version. Only acknowledge the
      // queued version when both records still match that version.
      await db.$transaction(async tx=>{
        const updated=await tx.receipt.updateMany({where:{id:r.id,sheetFingerprint:r.sheetFingerprint,
          syncStatus:{in:['PENDING','FAILED']}},data:{sheetRow:actualRow,sheetFingerprint:actualFingerprint}});
        if(!updated.count) return;
        const [currentReceipt,currentJob]=await Promise.all([
          tx.receipt.findUnique({where:{id:r.id}}),tx.outbox.findUnique({where:{id:job.id}}),
        ]);
        if(currentReceipt?.version!==job.version||currentJob?.version!==job.version||
           currentJob.updatedAt.getTime()!==job.updatedAt.getTime()||
           !['PENDING','FAILED'].includes(currentJob.status)) return;
        await tx.receipt.updateMany({where:{id:r.id,version:job.version,syncStatus:{in:['PENDING','FAILED']}},
          data:{syncStatus:'SYNCED'}});
        await tx.outbox.updateMany({where:{id:job.id,version:job.version,updatedAt:job.updatedAt,
          status:{in:['PENDING','FAILED']}},data:{status:'SYNCED',error:null}});
      });
    }catch(e){
      const message=e instanceof Error?e.message:String(e);
      if(message.includes('Xung đột')||message.includes('Trùng mã')){
        await conflict('receipt',r.id,message,receiptPayload(r),null,job.version);
        const current=await db.receipt.findUnique({where:{id:r.id}});
        if(current?.version===job.version&&current.syncStatus==='CONFLICT')
          await db.outbox.updateMany({where:{id:job.id,version:job.version,updatedAt:job.updatedAt,
            status:{in:['PENDING','FAILED']}},data:{status:'CONFLICT',error:message}});
      } else await db.outbox.updateMany({where:{id:job.id,version:job.version,updatedAt:job.updatedAt,
        status:{in:['PENDING','FAILED']}},data:{status:'FAILED',attempts:{increment:1},error:message,
        nextAttemptAt:new Date(Date.now()+Math.min(3600000,10000*2**Math.min(job.attempts,8)))}});
    }
  }
}

export async function flushCatalog(assertLease:()=>void=()=>{}){
  const jobs=await db.catalogOutbox.findMany({where:{status:{in:['PENDING','FAILED']}}});
  for(const job of jobs){
    assertLease();
    try{
      // Refresh after every write: two new records may otherwise target the same row.
      const s=await readSnapshot();
      if(job.kind==='house-delete'){
        const code=job.key.slice(6),row=s.houses.find(h=>h.code===code);
        if(row){assertLease();await clearCatalog('house',row.row);}
        const actual=(await readSnapshot()).houses.find(h=>h.code===code);
        if(actual) throw new Error('Không xóa được tòa nhà khỏi Google Sheets');
        await db.catalogOutbox.updateMany({where:{key:job.key,updatedAt:job.updatedAt,status:{in:['PENDING','FAILED']}},data:{status:'SYNCED',error:null}});
      }else if(job.kind==='account-delete'){
        const name=job.key.slice(8),row=s.accounts.find(a=>a.name===name);
        if(row){assertLease();await clearCatalog('account',row.row);}
        const actual=(await readSnapshot()).accounts.find(a=>a.name===name);
        if(actual) throw new Error('Không xóa được tài khoản nhận khỏi Google Sheets');
        await db.catalogOutbox.updateMany({where:{key:job.key,updatedAt:job.updatedAt,status:{in:['PENDING','FAILED']}},data:{status:'SYNCED',error:null}});
      }else if(job.kind==='house'){
        const code=job.key.slice(6),item=await db.house.findUniqueOrThrow({where:{code}}),row=s.houses.find(h=>h.code===code);
        const equal=!!row&&row.name===item.name&&row.note===item.note&&row.active===item.active;
        if(catalogHasConflict(row?.fingerprint||null,item.sheetFingerprint,equal))
          throw new Error('Xung đột danh mục nhà');
        if(!equal){assertLease();await writeCatalog('house',row?.row||s.houseNextRow,{code,name:item.name,note:item.note,active:item.active});}
        const actual=(await readSnapshot()).houses.find(h=>h.code===code);
        if(!actual||actual.name!==item.name||actual.note!==item.note||actual.active!==item.active)
          throw new Error('Không đối chiếu được danh mục nhà sau khi ghi');
        await db.$transaction(async tx=>{
          const current=await tx.house.findUnique({where:{code}});
          const out=await tx.catalogOutbox.findUnique({where:{key:job.key}});
          await tx.house.updateMany({where:{code,sheetFingerprint:item.sheetFingerprint},data:{sheetFingerprint:actual.fingerprint}});
          if(current?.updatedAt.getTime()===item.updatedAt.getTime()&&out?.updatedAt.getTime()===job.updatedAt.getTime())
            await tx.catalogOutbox.updateMany({where:{key:job.key,updatedAt:job.updatedAt,status:{in:['PENDING','FAILED']}},
              data:{status:'SYNCED',error:null}});
        });
      }else if(job.kind==='account'){
        const name=job.key.slice(8),item=await db.bankAccount.findUniqueOrThrow({where:{name}}),row=s.accounts.find(a=>a.name===name);
        const equal=!!row&&row.note===item.note&&row.active===item.active;
        if(catalogHasConflict(row?.fingerprint||null,item.sheetFingerprint,equal))
          throw new Error('Xung đột tài khoản nhận');
        if(!equal){assertLease();await writeCatalog('account',row?.row||s.accountNextRow,{name:item.name,note:item.note,active:item.active});}
        const actual=(await readSnapshot()).accounts.find(a=>a.name===name);
        if(!actual||actual.note!==item.note||actual.active!==item.active)
          throw new Error('Không đối chiếu được tài khoản nhận sau khi ghi');
        await db.$transaction(async tx=>{
          const current=await tx.bankAccount.findUnique({where:{name}});
          const out=await tx.catalogOutbox.findUnique({where:{key:job.key}});
          await tx.bankAccount.updateMany({where:{name,sheetFingerprint:item.sheetFingerprint},data:{sheetFingerprint:actual.fingerprint}});
          if(current?.updatedAt.getTime()===item.updatedAt.getTime()&&out?.updatedAt.getTime()===job.updatedAt.getTime())
            await tx.catalogOutbox.updateMany({where:{key:job.key,updatedAt:job.updatedAt,status:{in:['PENDING','FAILED']}},
              data:{status:'SYNCED',error:null}});
        });
      }else throw new Error('Loại đồng bộ danh mục không hợp lệ');
    }catch(e){
      const message=String(e);
      if(message.includes('Xung đột')) await conflict(job.kind,job.key.split(':').slice(1).join(':'),message,null,null);
      await db.catalogOutbox.updateMany({where:{key:job.key,updatedAt:job.updatedAt,status:{in:['PENDING','FAILED']}},
        data:{status:message.includes('Xung đột')?'CONFLICT':'FAILED',error:message,attempts:{increment:1}}});
    }
  }
}

export async function runSyncCycle(){
  const token=crypto.randomUUID();
  const acquired=await acquireLease(LOCK,token,600000);
  if(!acquired) return {status:'BUSY'} as const;
  let leaseLost=false,renewing=false;
  const heartbeat=setInterval(async()=>{
    if(renewing)return;
    renewing=true;
    try{
      const ok=await renewLease(LOCK,token,600000);
      if(!ok)leaseLost=true;
    }catch{leaseLost=true;}
    finally{renewing=false;}
  },45000);
  heartbeat.unref();
  const assertLease=()=>{if(leaseLost)throw new Error('Mất quyền khóa đồng bộ; dừng ghi Sheets');};
  try {
    await assertBinding();
    const s=await readSnapshot();
    await pullSnapshot(s);
    // During migration we may read and reconcile Sheets, but must never write
    // financial records or catalog changes until the operator enables it.
    if(env.COLLECTIONS_ENABLED==='true'){
      await flushOutbox(assertLease);
      await flushCatalog(assertLease);
    }
    return {status:'OK',dues:s.dues.length,receipts:s.journal.filter(Boolean).length,spreadsheetId:s.spreadsheetId} as const;
  } finally {
    clearInterval(heartbeat);
    await releaseLease(LOCK,token);
  }
}
