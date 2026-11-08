import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { BankAccount, Prisma, Receipt, User } from '@prisma/client';
import { acquireLease, db, keyScope, releaseLease } from './db.js';
import { cookieSecure, env } from './env.js';
import { balance, checkAmount, clean, key, monthValid, newReceiptId, parseDate, safeNumber, sum, vnd, dayText } from './business.js';
import { makePdf, makeZip, type ReportGroup } from './reports.js';
import { assertBinding, pullSnapshot, runSyncCycle } from './sync.js';
import { verifySpreadsheet, readSnapshot } from './sheets.js';

type Identity={id:string;login:string;name:string;role:string;houses:string[];accounts:string[]};
const app=Fastify({logger:{redact:['req.headers.cookie','req.headers.authorization']},bodyLimit:100000});
await app.register(cookie);
await app.register(helmet,{contentSecurityPolicy:false});

let sheetRefresh:Promise<void>|null=null;
async function refreshSheetCacheIfStale(){
  const state=await db.syncState.findUnique({where:{key:'dueLastRead'}});
  const last=state?.value?Date.parse(state.value):0;
  if(Number.isFinite(last)&&Date.now()-last<env.SHEET_POLL_SECONDS*1000)return;
  if(!sheetRefresh)sheetRefresh=(async()=>{
    const snapshot=await readSnapshot();
    await pullSnapshot(snapshot);
  })().catch(e=>{
    app.log.warn({err:e},'Không thể làm mới dữ liệu Google Sheets, dùng dữ liệu cache hiện có');
  }).finally(()=>{sheetRefresh=null;});
  await sheetRefresh;
}

async function explicitHouseStates(){
  const audits=await db.audit.findMany({
    where:{action:{in:['HOUSE_SAVE','HOUSE_DELETE']}},
    select:{entityId:true,action:true,createdAt:true},
    orderBy:{createdAt:'desc'},
  });
  const latest=new Map<string,string>();
  for(const row of audits)if(row.entityId&&!latest.has(row.entityId))latest.set(row.entityId,row.action);
  const saved=new Set<string>(),deleted=new Set<string>();
  for(const [code,action] of latest)if(action==='HOUSE_SAVE')saved.add(code);else deleted.add(code);
  return {saved,deleted};
}

const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
const tokenHash=(token:string)=>createHash('sha256').update(env.SESSION_SECRET+':'+token).digest('hex');
const currentDate=()=>{
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return parseDate(parts)!;
};
async function registerLoginAttempt(limitKey:string){
  const now=new Date(),expiresAt=new Date(Date.now()+15*60000);
  return db.$transaction(async tx=>{
    const prior=await tx.loginAttempt.findUnique({where:{key:limitKey}});
    if(!prior||prior.expiresAt<=now){
      const row=await tx.loginAttempt.upsert({where:{key:limitKey},create:{key:limitKey,attempts:1,expiresAt},update:{attempts:1,expiresAt}});
      return row.attempts;
    }
    const row=await tx.loginAttempt.update({where:{key:limitKey},data:{attempts:{increment:1}}});
    return row.attempts;
  },{isolationLevel:'Serializable'});
}
const ident=(u:User & {houses:{houseCode:string}[];accounts:{accountName:string}[]}):Identity=>({id:u.id,login:u.login,name:u.name,role:u.role,
  houses:u.houses.map(h=>h.houseCode),accounts:u.accounts.map(a=>a.accountName)});
const all=(u:Identity)=>u.role==='ADMIN';
const scopedHouse=(u:Identity,house:string)=>all(u)||u.houses.includes(house);
const scopedAccount=(u:Identity,account:string)=>all(u)||u.accounts.includes(account);
const scopeReceipt=(u:Identity):Prisma.ReceiptWhereInput=>all(u)?{}:u.role==='KETOAN'?{houseCode:{in:u.houses}}:{houseCode:{in:u.houses},createdById:u.id};
const canWriteReceipts=(u:Identity)=>u.role!=='KETOAN';
const publicReceipt=(r:Receipt)=>({...r,amount:safeNumber(r.amount),receivedAt:dayText(r.receivedAt),transferAt:dayText(r.transferAt)});
const obj=z.record(z.string(),z.unknown());
function input<T extends z.ZodTypeAny>(schema:T,value:unknown):z.infer<T>{return schema.parse(value);}
function permission(condition:boolean){if(!condition)throw Object.assign(new Error('Không có quyền truy cập'),{statusCode:403});}
function writable(){permission(env.COLLECTIONS_ENABLED==='true');}
function amountText(value:unknown){return vnd(value);}
const fields=z.object({month:z.string(),houseCode:z.string().trim().min(1),room:z.string().trim().min(1),amount:z.union([z.string(),z.number().int().safe()]),
  method:z.enum(['Tiền mặt','Chuyển khoản']),accountName:z.string().nullable().optional(),payer:z.string().max(200).default(''),note:z.string().max(2000).default(''),
  transferAt:z.string().nullable().optional(),transferMemo:z.string().max(1000).default('')});
const receiptInput=fields.extend({id:z.string().regex(/^VW-[0-9a-f-]{36}$/i).optional(),receivedAt:z.string().optional(),allowDuplicate:z.boolean().optional()});
function validateReceipt(data:z.infer<typeof fields>,u:Identity){
  if(!monthValid(data.month))throw new Error('Tháng thu phải là yyyy-MM');
  const house=key(data.houseCode);
  permission(scopedHouse(u,house));
  const amount=amountText(data.amount);
  const accountName=data.method==='Chuyển khoản'?clean(data.accountName):null;
  const transferAt=data.method==='Chuyển khoản'?parseDate(data.transferAt,true):null;
  if(data.method==='Chuyển khoản'){
    if(!accountName||!clean(data.transferMemo))throw new Error('Chuyển khoản yêu cầu tài khoản, ngày và nội dung chuyển khoản');
    permission(scopedAccount(u,accountName));
  }
  return {month:data.month,houseCode:house,room:data.room,amount,method:data.method,accountName,transferAt,transferMemo:data.method==='Chuyển khoản'?clean(data.transferMemo):'',payer:clean(data.payer),note:clean(data.note)};
}
async function lockRoom(tx:Prisma.TransactionClient,month:string,house:string,room:string){
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${month+'|'+house+'|'+room}))`;
}
async function ensureAmount(tx:Prisma.TransactionClient,data:{month:string;houseCode:string;room:string;amount:bigint},exclude?:string){
  const due=await tx.due.findUnique({where:{month_houseCode_room:{month:data.month,houseCode:data.houseCode,room:data.room}}});
  if(!due)throw new Error('Phòng/tháng chưa có số cần thu trong NHẬP CẦN THU');
  const paid=await tx.receipt.aggregate({where:{month:data.month,houseCode:data.houseCode,room:data.room,status:'ACTIVE',...(exclude?{id:{not:exclude}}:{})},_sum:{amount:true}});
  checkAmount(data.amount,balance(due.amount,paid._sum.amount||0n));
}
async function enqueue(tx:Prisma.TransactionClient,id:string,version:number,operation:string){
  await tx.outbox.upsert({where:{receiptId:id},create:{receiptId:id,version,operation},update:{version,operation,status:'PENDING',attempts:0,error:null,nextAttemptAt:new Date()}});
}
async function audit(tx:Prisma.TransactionClient,u:Identity,action:string,id:string,before?:unknown,after?:unknown){
  await tx.audit.create({data:{actorId:u.id,actorLogin:u.login,action,entityId:id,before:before?json(before):undefined,after:after?json(after):undefined}});
}

app.addHook('onRequest',async(request,reply)=>{
  const url=request.url.split('?')[0];
  if(!url.startsWith('/api/')||url==='/api/health'||url==='/api/auth/login')return;
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
    const origin=request.headers.origin;
    const forwardedOrigin=request.headers['x-vincent-public-origin'];
    const allowedOrigin=typeof forwardedOrigin==='string'&&forwardedOrigin?forwardedOrigin:new URL(env.APP_URL).origin;
    if(origin&&origin!==allowedOrigin){reply.code(403).send({error:'Nguồn gửi yêu cầu không hợp lệ'});return;}
    if(request.headers['sec-fetch-site']==='cross-site'){reply.code(403).send({error:'Yêu cầu khác nguồn bị từ chối'});return;}
  }
  const sessionId=request.cookies.vincent_session;
  if(!sessionId){reply.code(401).send({error:'Vui lòng đăng nhập'});return;}
  const session=await db.session.findUnique({where:{tokenHash:tokenHash(sessionId)},include:{user:{include:{houses:true,accounts:true}}}});
  if(!session||session.expiresAt<=new Date()||!session.user.active||session.version!==session.user.sessionVersion){
    reply.clearCookie('vincent_session',{path:'/'}).code(401).send({error:'Phiên đăng nhập đã hết hạn'});return;
  }
  (request as any).identity=ident(session.user);
  if(url.startsWith('/api/admin/')&&session.user.role!=='ADMIN'){
    reply.code(403).send({error:'Chỉ quản trị viên được truy cập'});return;
  }
});
const me=(r:any):Identity=>r.identity;

app.get('/api/health',async()=>{await db.$queryRaw`SELECT 1`;return {ok:true,service:'vincent-api'};});
app.post('/api/auth/login',async(req,reply)=>{
  const body=input(z.object({login:z.string().trim().min(3),password:z.string().min(1)}),req.body);
  const limitKey=keyScope+'login:'+createHash('sha256').update(req.ip+':'+body.login).digest('hex');
  const attempts=await registerLoginAttempt(limitKey);
  if(attempts>10)return reply.code(429).send({error:'Đăng nhập sai quá nhiều lần. Thử lại sau 15 phút.'});
  const user=await db.user.findUnique({where:{login:body.login},include:{houses:true,accounts:true}});
  if(!user?.active||!user.passwordHash||!await argon2.verify(user.passwordHash,body.password))return reply.code(401).send({error:'Số điện thoại hoặc mật khẩu không đúng'});
  await db.loginAttempt.deleteMany({where:{key:limitKey}});
  const token=randomBytes(32).toString('base64url');
  await db.session.create({data:{tokenHash:tokenHash(token),userId:user.id,version:user.sessionVersion,expiresAt:new Date(Date.now()+7*86400000)}});
  reply.setCookie('vincent_session',token,{path:'/',httpOnly:true,secure:cookieSecure,sameSite:'strict',maxAge:7*86400});
  return {user:ident(user),collectionsEnabled:env.COLLECTIONS_ENABLED==='true'};
});
app.post('/api/auth/logout',async(req,reply)=>{
  const token=req.cookies.vincent_session;
  if(token)await db.session.deleteMany({where:{tokenHash:tokenHash(token)}});
  reply.clearCookie('vincent_session',{path:'/'});
  return {ok:true};
});
app.get('/api/auth/me',async req=>({user:me(req),collectionsEnabled:env.COLLECTIONS_ENABLED==='true'}));

app.get('/api/metadata',async req=>{
  await refreshSheetCacheIfStale();
  const u=me(req),[catalogHouses,dueHouses,houseStates,accounts,months,updated]=await Promise.all([
    db.house.findMany({where:all(u)?{active:true}:{active:true,code:{in:u.houses}},orderBy:{code:'asc'}}),
    db.due.groupBy({by:['houseCode'],where:all(u)?{}:{houseCode:{in:u.houses}},orderBy:{houseCode:'asc'}}),
    explicitHouseStates(),
    db.bankAccount.findMany({where:all(u)?{active:true}:{active:true,name:{in:u.accounts}},orderBy:{name:'asc'}}),
    db.syncState.findUnique({where:{key:'months'}}),db.syncState.findUnique({where:{key:'dueLastRead'}}),
  ]);
  const catalogByCode=new Map(catalogHouses.map(h=>[h.code,h]));
  const houseMap=new Map<string,(typeof catalogHouses)[number]>();
  for(const h of dueHouses){
    if(houseStates.deleted.has(h.houseCode))continue;
    houseMap.set(h.houseCode,catalogByCode.get(h.houseCode)||{code:h.houseCode,name:'',note:'',active:true,sheetFingerprint:null,updatedAt:new Date(0)});
  }
  for(const h of catalogHouses)if(houseStates.saved.has(h.code)&&!houseStates.deleted.has(h.code))houseMap.set(h.code,h);
  const houses=[...houseMap.values()].sort((a,b)=>a.code.localeCompare(b.code,'vi'));
  return {houses,accounts,months:months?JSON.parse(months.value):[],dueLastRead:updated?.value||null};
});

app.get('/api/dues',async req=>{
  const u=me(req),q=input(z.object({month:z.string(),house:z.string().optional(),search:z.string().optional(),page:z.coerce.number().int().min(1).default(1),summary:z.enum(['true']).optional()}),req.query);
  if(!monthValid(q.month))throw new Error('Tháng không hợp lệ');
  const houses=all(u)?(q.house?[key(q.house)]:undefined):q.house?(permission(scopedHouse(u,key(q.house))),[key(q.house)]):u.houses;
  const where:Prisma.DueWhereInput={month:q.month,...(houses?{houseCode:{in:houses}}:{}),...(q.search?{OR:[{room:{contains:q.search,mode:'insensitive'}},{houseCode:{contains:q.search,mode:'insensitive'}}]}:{})};
  const [total,dues,summaryDues]=await Promise.all([
    db.due.count({where}),
    db.due.findMany({where,orderBy:[{houseCode:'asc'},{room:'asc'}],skip:(q.page-1)*100,take:100}),
    q.summary?db.due.findMany({where,select:{houseCode:true,room:true,amount:true}}):Promise.resolve(null),
  ]);
  const relevantDues=summaryDues||dues;
  const paid=await db.receipt.groupBy({by:['houseCode','room'],where:{month:q.month,status:'ACTIVE',houseCode:{in:[...new Set(relevantDues.map(d=>d.houseCode))]}},_sum:{amount:true}});
  const paidMap=new Map(paid.map(p=>[p.houseCode+'|'+p.room,p._sum.amount||0n]));
  const roomsPaid=summaryDues?.filter(d=>(paidMap.get(d.houseCode+'|'+d.room)||0n)>=d.amount).length;
  return {total,page:q.page,
    items:dues.map(d=>({month:d.month,houseCode:d.houseCode,room:d.room,due:safeNumber(d.amount),paid:safeNumber(paidMap.get(d.houseCode+'|'+d.room)||0n),remaining:safeNumber(balance(d.amount,paidMap.get(d.houseCode+'|'+d.room)||0n))})),
    ...(roomsPaid===undefined?{}:{summary:{total,roomsPaid,roomsIncomplete:total-roomsPaid}}),
  };
});

app.get('/api/dashboard',async req=>{
  const u=me(req),q=input(z.object({month:z.string()}),req.query);
  if(!monthValid(q.month))throw new Error('Tháng không hợp lệ');
  const where:Prisma.DueWhereInput={month:q.month,...(!all(u)?{houseCode:{in:u.houses}}:{})};
  const [dues,receipts]=await Promise.all([db.due.findMany({where}),db.receipt.findMany({where:{month:q.month,status:'ACTIVE',...(!all(u)?{houseCode:{in:u.houses}}:{})}})]);
  const paidMap=new Map<string,bigint>();for(const r of receipts){const k=r.houseCode+'|'+r.room;paidMap.set(k,(paidMap.get(k)||0n)+r.amount);}
  const byHouse=new Map<string,{due:bigint;paid:bigint}>();
  let due=0n,paid=0n,full=0,partial=0,unpaid=0;
  for(const d of dues){const p=paidMap.get(d.houseCode+'|'+d.room)||0n;due+=d.amount;paid+=p;
    if(p>=d.amount)full++;else if(p>0n)partial++;else unpaid++;
    const curr=byHouse.get(d.houseCode)||{due:0n,paid:0n};curr.due+=d.amount;curr.paid+=p;byHouse.set(d.houseCode,curr);
  }
  const visible=u.role==='NV'?receipts.filter(r=>r.createdById===u.id):receipts;
  const money=(rs:Receipt[])=>safeNumber(sum(rs.map(r=>r.amount)));
  const byAccounts=new Map<string,bigint>();for(const r of visible)if(r.method==='Chuyển khoản'&&r.accountName)byAccounts.set(r.accountName,(byAccounts.get(r.accountName)||0n)+r.amount);
  const byDays=new Map<string,bigint>();for(const r of visible){const d=dayText(r.receivedAt);byDays.set(d,(byDays.get(d)||0n)+r.amount);}
  return {month:q.month,scope:all(u)?'Toàn hệ thống':'Nhà được phân quyền',due:safeNumber(due),paid:safeNumber(paid),remaining:safeNumber(balance(due,paid)),
    cash:money(visible.filter(r=>r.method==='Tiền mặt')),transfer:money(visible.filter(r=>r.method==='Chuyển khoản')),myCollected:money(visible),
    roomsPaid:full,roomsPartial:partial,roomsUnpaid:unpaid,count:visible.length,
    houses:[...byHouse].map(([code,s])=>({code,due:safeNumber(s.due),paid:safeNumber(s.paid),remaining:safeNumber(balance(s.due,s.paid))})),
    accounts:[...byAccounts].map(([name,n])=>({name,amount:safeNumber(n)})),daily:[...byDays].map(([day,n])=>({day,amount:safeNumber(n)}))};
});

app.get('/api/receipts',async req=>{
  const u=me(req),q=input(z.object({month:z.string().optional(),house:z.string().optional(),room:z.string().optional(),search:z.string().optional(),method:z.string().optional(),status:z.enum(['ACTIVE','DELETED']).optional(),page:z.coerce.number().int().min(1).default(1),size:z.coerce.number().int().min(1).max(100).default(30)}),req.query);
  const where:Prisma.ReceiptWhereInput={...scopeReceipt(u),status:q.status||'ACTIVE',...(q.month?{month:q.month}:{}),...(q.house?{houseCode:key(q.house)}:{}),...(q.room?{room:q.room}:{}),...(q.method?{method:q.method}:{}),
    ...(q.search?{OR:[{id:{contains:q.search,mode:'insensitive'}},{payer:{contains:q.search,mode:'insensitive'}},{transferMemo:{contains:q.search,mode:'insensitive'}},{room:{contains:q.search,mode:'insensitive'}}]}:{})};
  const [total,items]=await Promise.all([db.receipt.count({where}),db.receipt.findMany({where,orderBy:{createdAt:'desc'},skip:(q.page-1)*q.size,take:q.size})]);
  return {total,page:q.page,size:q.size,items:items.map(publicReceipt)};
});

app.post('/api/receipts',async req=>{
  writable();const u=me(req);permission(canWriteReceipts(u));const body=input(receiptInput,req.body),data=validateReceipt(body,u);
  const id=body.id||newReceiptId();const receivedAt=body.receivedAt?parseDate(body.receivedAt,true)!:currentDate();
  const result=await db.$transaction(async tx=>{
    await lockRoom(tx,data.month,data.houseCode,data.room);
    const existing=await tx.receipt.findUnique({where:{id}});
    if(existing){
      permission(all(u)||(existing.createdById===u.id&&scopedHouse(u,existing.houseCode)));
      if(existing.status==='ACTIVE'&&existing.receivedAt.getTime()===receivedAt.getTime()&&sameRequest(existing,data))return existing;
      throw Object.assign(new Error('Mã giao dịch đã được dùng với nội dung khác'),{statusCode:409});
    }
    const house=await tx.house.findUnique({where:{code:data.houseCode}});
    if(house&&!house.active)throw new Error('Nhà đã ngừng sử dụng');
    if(data.accountName){const account=await tx.bankAccount.findUnique({where:{name:data.accountName}});if(!account?.active)throw new Error('Tài khoản nhận chưa được kích hoạt');}
    await ensureAmount(tx,data);
    if(!body.allowDuplicate){
      const duplicate=await tx.receipt.findFirst({where:{month:data.month,houseCode:data.houseCode,room:data.room,amount:data.amount,
        method:data.method,accountName:data.accountName,transferAt:data.transferAt,transferMemo:data.transferMemo,status:'ACTIVE',
        ...(data.method==='Tiền mặt'?{createdAt:{gte:new Date(Date.now()-15*60000)}}:{})}});
      if(duplicate)throw Object.assign(new Error(`Có thể trùng giao dịch ${duplicate.id}. Kiểm tra trước khi thu lại.`),{statusCode:409});
    }
    const created=await tx.receipt.create({data:{id,...data,receivedAt,collector:u.name,createdById:u.id,updatedById:u.id,syncStatus:'PENDING'}});
    await enqueue(tx,id,1,'UPSERT');await audit(tx,u,'RECEIPT_CREATE',id,undefined,created);
    return created;
  },{isolationLevel:'Serializable',timeout:12000});
  return {receipt:publicReceipt(result),syncStatus:result.syncStatus};
});
function sameRequest(r:Receipt,d:ReturnType<typeof validateReceipt>){
  return r.month===d.month&&r.houseCode===d.houseCode&&r.room===d.room&&r.amount===d.amount&&r.method===d.method&&
    r.accountName===d.accountName&&r.transferAt?.getTime()===d.transferAt?.getTime()&&r.transferMemo===d.transferMemo&&r.payer===d.payer&&r.note===d.note;
}
app.patch('/api/receipts/:id',async req=>{
  writable();const u=me(req);permission(canWriteReceipts(u));const {id}=input(z.object({id:z.string()}),req.params);
  const body=input(fields.extend({version:z.number().int().min(1)}),req.body),data=validateReceipt(body,u);
  const result=await db.$transaction(async tx=>{
    const old=await tx.receipt.findUnique({where:{id}});
    if(!old||old.status!=='ACTIVE')throw Object.assign(new Error('Không tìm thấy giao dịch đang hoạt động'),{statusCode:404});
    permission(all(u)||(old.createdById===u.id&&scopedHouse(u,old.houseCode)));
    const rooms=[old.month+'|'+old.houseCode+'|'+old.room,data.month+'|'+data.houseCode+'|'+data.room];
    for(const room of [...new Set(rooms)].sort())await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${room}))`;
    if(old.version!==body.version)throw Object.assign(new Error('Giao dịch đã được chỉnh sửa ở nơi khác'),{statusCode:409});
    if(old.source==='LEGACY')throw new Error('Giao dịch V6 thiếu mã K cần đối soát trước khi sửa');
    await ensureAmount(tx,data,id);
    const updated=await tx.receipt.update({where:{id},data:{...data,collector:old.collector,version:{increment:1},syncStatus:'PENDING',updatedById:u.id}});
    await enqueue(tx,id,updated.version,'UPSERT');await audit(tx,u,'RECEIPT_EDIT',id,old,updated);
    return updated;
  },{isolationLevel:'Serializable',timeout:12000});
  return {receipt:publicReceipt(result)};
});
app.delete('/api/receipts/:id',async req=>{
  writable();const u=me(req);permission(canWriteReceipts(u));const {id}=input(z.object({id:z.string()}),req.params);
  const {version}=input(z.object({version:z.number().int().min(1)}),req.body);
  const r=await db.$transaction(async tx=>{
    const old=await tx.receipt.findUnique({where:{id}});
    if(!old||old.status!=='ACTIVE')throw Object.assign(new Error('Không tìm thấy giao dịch'),{statusCode:404});
    permission(all(u)||(old.createdById===u.id&&scopedHouse(u,old.houseCode)));
    await lockRoom(tx,old.month,old.houseCode,old.room);
    if(old.version!==version)throw Object.assign(new Error('Dữ liệu đã thay đổi'),{statusCode:409});
    if(old.source==='LEGACY')throw new Error('Cần đối soát giao dịch thiếu mã K trước khi hủy');
    const updated=await tx.receipt.update({where:{id},data:{status:'DELETED',deletedAt:new Date(),syncStatus:'PENDING',version:{increment:1},updatedById:u.id}});
    await enqueue(tx,id,updated.version,'DELETE');await audit(tx,u,'RECEIPT_CANCEL',id,old,updated);
    return updated;
  },{isolationLevel:'Serializable',timeout:12000});
  return {receipt:publicReceipt(r)};
});

app.get('/api/reports/transfers',async(req,reply)=>{
  const u=me(req),q=input(z.object({month:z.string().optional(),from:z.string().optional(),to:z.string().optional(),house:z.string().optional(),room:z.string().optional(),collector:z.string().optional(),accountNames:z.string().optional(),status:z.enum(['ACTIVE','DELETED']).default('ACTIVE'),format:z.enum(['json','pdf','zip']).default('json')}),req.query);
  const allowed=q.accountNames?.split(',').map(clean).filter(Boolean);
  if(allowed)for(const name of allowed)permission(scopedAccount(u,name));
  if(q.house)permission(scopedHouse(u,key(q.house)));
  const optionScope=all(u)?undefined:u.accounts;
  const [optionCatalog,historicalAccountRows]=await Promise.all([
    db.bankAccount.findMany({where:{...(optionScope?{name:{in:optionScope}}:{})},orderBy:{name:'asc'}}),
    db.receipt.findMany({where:{...scopeReceipt(u),method:'Chuyển khoản',accountName:{not:null},...(optionScope?{accountName:{in:optionScope}}:{})},select:{accountName:true},distinct:['accountName'],orderBy:{accountName:'asc'}}),
  ]);
  const optionByName=new Map(optionCatalog.map(a=>[a.name,a]));
  for(const row of historicalAccountRows)if(row.accountName&&!optionByName.has(row.accountName))optionByName.set(row.accountName,{name:row.accountName,owner:'',bank:'',number:'',note:'',active:false,sheetFingerprint:null,updatedAt:new Date(0)});
  const accountOptions=[...optionByName.values()].sort((a,b)=>a.name.localeCompare(b.name,'vi'));
  const accountScope=allowed || (all(u)?undefined:u.accounts);
  const accounts=await db.bankAccount.findMany({where:{...(accountScope?{name:{in:accountScope}}:{})},orderBy:{name:'asc'}});
  const where:Prisma.ReceiptWhereInput={...scopeReceipt(u),method:'Chuyển khoản',status:q.status,
    ...(accountScope?{accountName:{in:accountScope}}:{}),
    ...(q.month?{month:q.month}:{}),...(q.house?{houseCode:key(q.house)}:{}),...(q.room?{room:q.room}:{}),...(q.collector?{collector:{contains:q.collector,mode:'insensitive'}}:{}),
    ...(q.from||q.to?{transferAt:{...(q.from?{gte:parseDate(q.from,true)!}:{}),...(q.to?{lte:parseDate(q.to,true)!}:{})}}:{})};
  const receipts=await db.receipt.findMany({where,orderBy:[{transferAt:'asc'},{id:'asc'}]});
  // Imported historical transfers may reference an account that is no longer
  // present in the account catalog. Never silently drop those transactions.
  const accountByName=new Map(accounts.map(a=>[a.name,a]));
  const names=[...new Set([...accounts.map(a=>a.name),...receipts.map(r=>r.accountName).filter((s):s is string=>!!s),...(allowed||[])])].sort();
  const groups:ReportGroup[]=names.map(name=>{
    const account:BankAccount=accountByName.get(name)||{name,owner:'',bank:'',number:'',note:'',active:false,sheetFingerprint:null,updatedAt:new Date(0)};
    const items=receipts.filter(r=>r.accountName===name);
    return {account,receipts:items,total:q.status==='DELETED'?0n:sum(items.map(r=>r.amount))};
  });
  const filter={month:q.month,from:q.from,to:q.to};
  if(q.format==='pdf'){const file=await makePdf(groups,filter);reply.header('Content-Type','application/pdf').header('Content-Disposition','attachment; filename="vincent-chuyen-khoan.pdf"');return reply.send(file);}
  if(q.format==='zip'){const file=await makeZip(groups,filter);reply.header('Content-Type','application/zip').header('Content-Disposition','attachment; filename="vincent-tai-khoan.zip"');return reply.send(file);}
  return {groups:groups.map(g=>({account:g.account,count:g.receipts.length,total:safeNumber(g.total),receipts:g.receipts.map(publicReceipt)})),total:safeNumber(sum(groups.map(g=>g.total))),accountOptions};
});

app.get('/api/admin/users',async()=>{
  const users=await db.user.findMany({where:{active:true},include:{houses:true,accounts:true},orderBy:{name:'asc'}});
  return users.map(u=>({...ident(u),active:u.active,hasPassword:!!u.passwordHash}));
});
const userData=z.object({login:z.string().regex(/^\+?\d{9,15}$/),name:z.string().trim().min(2).max(100),password:z.string().min(10).optional(),role:z.enum(['ADMIN','NV','KETOAN']).default('NV'),active:z.boolean().default(true),houses:z.array(z.string()).default([]),accounts:z.array(z.string()).default([])});
app.post('/api/admin/users',async req=>{
  const u=me(req),body=input(userData.extend({password:z.string().min(10)}),req.body);
  const hashed=await argon2.hash(body.password,{type:argon2.argon2id});
  const created=await db.$transaction(async tx=>{
    const existing=await tx.user.findUnique({where:{login:body.login}});
    if(existing?.active)throw Object.assign(new Error('Số điện thoại này đã có tài khoản đang hoạt động'),{statusCode:409});
    let target:User;
    if(existing){
      await tx.session.deleteMany({where:{userId:existing.id}});
      await tx.userHouse.deleteMany({where:{userId:existing.id}});
      await tx.userAccount.deleteMany({where:{userId:existing.id}});
      target=await tx.user.update({where:{id:existing.id},data:{name:body.name,role:body.role,active:true,passwordHash:hashed,legacySalt:null,legacyHash:null,sessionVersion:{increment:1}}});
    }else{
      target=await tx.user.create({data:{login:body.login,name:body.name,role:body.role,active:true,passwordHash:hashed}});
    }
    if(body.houses.length)await tx.userHouse.createMany({data:body.houses.map(houseCode=>({userId:target.id,houseCode:key(houseCode)})),skipDuplicates:true});
    if(body.accounts.length)await tx.userAccount.createMany({data:body.accounts.map(accountName=>({userId:target.id,accountName})),skipDuplicates:true});
    await audit(tx,u,existing?'USER_RESTORE':'USER_CREATE',target.id,existing?{login:existing.login,name:existing.name,role:existing.role,active:existing.active}:undefined,{login:target.login,name:target.name,role:target.role});
    return target;
  },{isolationLevel:'Serializable'});
  return {id:created.id};
});
app.patch('/api/admin/users/:id',async req=>{
  const u=me(req),{id}=input(z.object({id:z.string()}),req.params),body=input(userData.partial().omit({login:true}),req.body);
  if(body.role&&body.role!=='ADMIN'&&id===u.id)throw new Error('Không thể tự hạ quyền admin');
  if(body.active===false&&id===u.id)throw new Error('Không thể tự khóa tài khoản đang đăng nhập');
  const passwordHash=body.password?await argon2.hash(body.password,{type:argon2.argon2id}):undefined;
  await db.$transaction(async tx=>{
    const existing=await tx.user.findUniqueOrThrow({where:{id}});
    if(existing.active&&existing.role==='ADMIN'&&(body.active===false||(body.role&&body.role!=='ADMIN'))){
      const count=await tx.user.count({where:{role:'ADMIN',active:true}});
      if(count<=1)throw Object.assign(new Error('Phải giữ ít nhất một quản trị viên đang hoạt động'),{statusCode:409});
    }
    await tx.user.update({where:{id},data:{name:body.name,role:body.role,active:body.active,passwordHash,
      sessionVersion:{increment:1},...(body.houses?{houses:{deleteMany:{},create:body.houses.map(houseCode=>({houseCode:key(houseCode)}))}}:{}),
      ...(body.accounts?{accounts:{deleteMany:{},create:body.accounts.map(accountName=>({accountName}))}}:{})}});
    await audit(tx,u,'USER_UPDATE',id,undefined,{...body,password:undefined});
  },{isolationLevel:'Serializable'});
  return {ok:true};
});

app.delete('/api/admin/users/:id',async req=>{
  const u=me(req),{id}=input(z.object({id:z.string()}),req.params);
  if(id===u.id)throw Object.assign(new Error('Không thể xóa tài khoản đang đăng nhập'),{statusCode:409});
  await db.$transaction(async tx=>{
    const existing=await tx.user.findUniqueOrThrow({where:{id}});
    if(existing.role==='ADMIN'&&existing.active){
      const count=await tx.user.count({where:{role:'ADMIN',active:true}});
      if(count<=1)throw Object.assign(new Error('Phải giữ ít nhất một quản trị viên đang hoạt động'),{statusCode:409});
    }
    await tx.session.deleteMany({where:{userId:id}});
    await tx.userHouse.deleteMany({where:{userId:id}});
    await tx.userAccount.deleteMany({where:{userId:id}});
    await tx.user.update({where:{id},data:{active:false,sessionVersion:{increment:1}}});
    await audit(tx,u,'USER_DELETE',id,{login:existing.login,name:existing.name,role:existing.role},undefined);
  },{isolationLevel:'Serializable'});
  return {ok:true};
});

app.get('/api/admin/houses',async()=>{
  const [catalogHouses,dueHouses,houseStates]=await Promise.all([
    db.house.findMany({where:{active:true},orderBy:{code:'asc'}}),
    db.due.groupBy({by:['houseCode'],orderBy:{houseCode:'asc'}}),
    explicitHouseStates(),
  ]);
  const catalogByCode=new Map(catalogHouses.map(h=>[h.code,h]));
  const houseMap=new Map<string,(typeof catalogHouses)[number]>();
  for(const h of dueHouses){
    if(houseStates.deleted.has(h.houseCode))continue;
    houseMap.set(h.houseCode,catalogByCode.get(h.houseCode)||{code:h.houseCode,name:'',note:'',active:true,sheetFingerprint:null,updatedAt:new Date(0)});
  }
  for(const h of catalogHouses)if(houseStates.saved.has(h.code)&&!houseStates.deleted.has(h.code))houseMap.set(h.code,h);
  return [...houseMap.values()].sort((a,b)=>a.code.localeCompare(b.code,'vi'));
});
app.post('/api/admin/houses',async req=>{
  const u=me(req),v=input(z.object({code:z.string().trim().min(1).max(30),name:z.string().max(200).default(''),note:z.string().max(1000).default('')}),req.body);
  const code=key(v.code);
  await db.$transaction(async tx=>{await tx.house.upsert({where:{code},create:{code,name:v.name,note:v.note,active:true},update:{name:v.name,note:v.note,active:true}});
    await tx.catalogOutbox.upsert({where:{key:'house:'+code},create:{key:'house:'+code,kind:'house'},update:{kind:'house',status:'PENDING',attempts:0,error:null}});
    await audit(tx,u,'HOUSE_SAVE',code,undefined,v);});return {code};
});
app.delete('/api/admin/houses/:code',async req=>{
  const u=me(req),{code:raw}=input(z.object({code:z.string().trim().min(1)}),req.params),code=key(raw);
  await db.$transaction(async tx=>{
    const old=await tx.house.findUnique({where:{code}});
    await tx.userHouse.deleteMany({where:{houseCode:code}});
    await tx.house.deleteMany({where:{code}});
    await tx.catalogOutbox.upsert({where:{key:'house:'+code},create:{key:'house:'+code,kind:'house-delete'},update:{kind:'house-delete',status:'PENDING',attempts:0,error:null}});
    await audit(tx,u,'HOUSE_DELETE',code,old,undefined);
  });
  return {ok:true};
});
app.get('/api/admin/accounts',async()=>db.bankAccount.findMany({where:{active:true},orderBy:{name:'asc'}}));
app.post('/api/admin/accounts',async req=>{
  const u=me(req),v=input(z.object({name:z.string().trim().min(1).max(100),bank:z.string().trim().min(1).max(200)}),req.body);
  await db.$transaction(async tx=>{await tx.bankAccount.upsert({where:{name:v.name},create:{name:v.name,bank:v.bank,owner:'',number:'',note:'',active:true},update:{bank:v.bank,owner:'',number:'',note:'',active:true}});
    await tx.catalogOutbox.upsert({where:{key:'account:'+v.name},create:{key:'account:'+v.name,kind:'account'},update:{kind:'account',status:'PENDING',attempts:0,error:null}});
    await audit(tx,u,'ACCOUNT_SAVE',v.name,undefined,v);});return {name:v.name};
});
app.delete('/api/admin/accounts/:name',async req=>{
  const u=me(req),{name}=input(z.object({name:z.string().trim().min(1)}),req.params);
  await db.$transaction(async tx=>{
    const old=await tx.bankAccount.findUniqueOrThrow({where:{name}});
    await tx.userAccount.deleteMany({where:{accountName:name}});
    await tx.bankAccount.delete({where:{name}});
    await tx.catalogOutbox.upsert({where:{key:'account:'+name},create:{key:'account:'+name,kind:'account-delete'},update:{kind:'account-delete',status:'PENDING',attempts:0,error:null}});
    await audit(tx,u,'ACCOUNT_DELETE',name,{...old,number:old.number.slice(-4)},undefined);
  });
  return {ok:true};
});

app.get('/api/admin/sync',async()=>{
  const [state,outbox,catalog,conflicts]=await Promise.all([db.syncState.findMany(),db.outbox.groupBy({by:['status'],_count:true}),db.catalogOutbox.findMany(),db.conflict.findMany({where:{resolved:false},orderBy:{createdAt:'desc'},take:100})]);
  return {binding:env.GOOGLE_SPREADSHEET_ID||null,collectionsEnabled:env.COLLECTIONS_ENABLED==='true',state,outbox,catalog,conflicts};
});
app.post('/api/admin/sync/run',async()=>runSyncCycle());
app.get('/api/admin/sync/verify',async()=>verifySpreadsheet());
app.post('/api/admin/sync/conflicts/:id/resolve',async req=>{
  const u=me(req),{id}=input(z.object({id:z.string()}),req.params),{strategy}=input(z.object({strategy:z.enum(['sheet','retry'])}),req.body);
  const lockName=keyScope+'sync-lock',lockToken=randomBytes(16).toString('hex');
  const acquired=await acquireLease(lockName,lockToken,180000);
  if(!acquired)throw Object.assign(new Error('Đang đồng bộ; thử xử lý xung đột sau khi hoàn tất'),{statusCode:409});
  try{
    const c=await db.conflict.findUniqueOrThrow({where:{id}});
    if(c.resolved)throw new Error('Xung đột đã được xử lý');
    if(c.entityType!=='receipt')throw new Error('Xung đột danh mục cần đối soát thủ công tại nguồn');
    const receipt=await db.receipt.findUniqueOrThrow({where:{id:c.entityId}});
    if(receipt.syncStatus!=='CONFLICT')throw Object.assign(new Error('Trạng thái giao dịch đã thay đổi'),{statusCode:409});
    const snap=await readSnapshot(),remotes=snap.journal.filter(r=>r?.id===receipt.id);
    const rawMatches=snap.rawJournal.slice(1).filter(row=>clean(row[10])===receipt.id);
    if(rawMatches.length!==remotes.length||remotes.length>1)
      throw Object.assign(new Error('Mã giao dịch trùng hoặc dòng NHẬT KÝ có mã K nhưng không đọc được; cần sửa nguồn'),{statusCode:409});
    if(!remotes.length && snap.journal.some((r,i)=>!r&&(snap.rawJournal[i+1]||[]).some(v=>clean(v))))
      throw Object.assign(new Error('NHẬT KÝ có dòng lỗi; chưa thể xác nhận giao dịch đã biến mất'),{statusCode:409});
    const remote=remotes[0];
    await db.$transaction(async tx=>{
      const [latest,latestConflict]=await Promise.all([
        tx.receipt.findUniqueOrThrow({where:{id:receipt.id}}),tx.conflict.findUniqueOrThrow({where:{id}}),
      ]);
      if(latest.version!==receipt.version||latest.syncStatus!=='CONFLICT'||latestConflict.resolved)
        throw Object.assign(new Error('Xung đột hoặc giao dịch đã thay đổi, cần tải lại'),{statusCode:409});
      if(strategy==='sheet'){
        if(remote)await tx.receipt.update({where:{id:receipt.id},data:{month:remote.month,houseCode:remote.houseCode,room:remote.room,collector:remote.collector,payer:remote.payer,amount:remote.amount,method:remote.method,
          accountName:remote.accountName,receivedAt:remote.receivedAt,transferAt:remote.transferAt,transferMemo:remote.transferMemo,note:remote.note,status:'ACTIVE',deletedAt:null,sheetRow:remote.sheetRow,sheetFingerprint:remote.sheetFingerprint,syncStatus:'SYNCED',version:{increment:1}}});
        else await tx.receipt.update({where:{id:receipt.id},data:{status:'DELETED',deletedAt:new Date(),syncStatus:'SYNCED',sheetFingerprint:null,sheetRow:null,version:{increment:1}}});
        await tx.outbox.updateMany({where:{receiptId:receipt.id},data:{status:'SYNCED',error:null}});
      }else{
        await tx.receipt.update({where:{id:receipt.id},data:{syncStatus:'PENDING',sheetRow:remote?.sheetRow||null,sheetFingerprint:remote?.sheetFingerprint||null}});
        await enqueue(tx,receipt.id,receipt.version,receipt.status==='DELETED'?'DELETE':'UPSERT');
      }
      await tx.conflict.update({where:{id},data:{resolved:true,resolvedAt:new Date()}});
      await audit(tx,u,'SYNC_CONFLICT_RESOLVE',receipt.id,undefined,{strategy,conflictId:id});
    },{isolationLevel:'Serializable'});
    return {ok:true,strategy};
  }finally{
    await releaseLease(lockName,lockToken);
  }
});
app.get('/api/admin/audit',async req=>{
  const q=input(z.object({page:z.coerce.number().int().min(1).default(1)}),req.query);
  return db.audit.findMany({orderBy:{createdAt:'desc'},skip:(q.page-1)*100,take:100});
});

app.setErrorHandler((err,req,reply)=>{
  const error=err as Error & {statusCode?:number;code?:string};
  const known=typeof error.statusCode==='number'?error.statusCode:400;
  const validation=err instanceof z.ZodError;
  const prismaConflict=error.code==='P2002'||error.code==='P2034';
  const status=prismaConflict?409:(validation?400:known);
  req.log.error({error:error.message,status},'Request error');
  reply.code(status).send({error:validation?'Dữ liệu gửi lên không hợp lệ':prismaConflict?'Xung đột thao tác; vui lòng thử lại':status>=500?'Lỗi máy chủ':error.message});
});

if(env.GOOGLE_SPREADSHEET_ID) await assertBinding();
await app.listen({port:env.PORT,host:'0.0.0.0'});
