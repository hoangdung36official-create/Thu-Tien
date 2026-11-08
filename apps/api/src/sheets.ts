import { google } from 'googleapis';
import { env } from './env.js';
import { SHEET_NAMES, fingerprint, readDues, readJournal, readJournalSafely, clean, key, fromSheetAmount } from './business.js';

function sheetsClient(){
  if(!env.GOOGLE_SPREADSHEET_ID||!env.GOOGLE_SERVICE_ACCOUNT_EMAIL||!env.GOOGLE_PRIVATE_KEY)
    throw new Error('Google Sheets chưa được cấu hình');
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return {api:google.sheets({ version: 'v4', auth }),id:env.GOOGLE_SPREADSHEET_ID};
}
export const sheetRef = (tab: string, range: string) => `'${tab.replace(/'/g,"''")}'!${range}`;

export type SheetSnapshot = {
  spreadsheetId: string;
  title: string;
  tabIds: Record<string,number>;
  months: string[];
  dues: ReturnType<typeof readDues>['dues'];
  journal: ReturnType<typeof readJournal>[];
  rawJournal: unknown[][];
  houseNextRow: number;
  accountNextRow: number;
  houses: {code:string; name:string; note:string; active:boolean; row:number; fingerprint:string}[];
  accounts: {name:string; note:string; active:boolean; row:number; fingerprint:string}[];
  users: {login:string;name:string;role:string;active:boolean;houses:string[];accounts:string[];legacySalt:string|null;legacyHash:string|null}[];
};

export async function verifySpreadsheet(): Promise<{title:string;tabIds:Record<string,number>}> {
  const {api,id}=sheetsClient();
  const metadata=await api.spreadsheets.get({spreadsheetId:id,fields:'spreadsheetId,properties(title),sheets(properties(sheetId,title))'});
  if (metadata.data.spreadsheetId!==id) throw new Error('Spreadsheet ID phản hồi không trùng cấu hình');
  const tabIds: Record<string,number>={};
  for (const s of metadata.data.sheets || []) if(s.properties?.title && s.properties.sheetId!==undefined && s.properties.sheetId!==null)
    tabIds[s.properties.title]=s.properties.sheetId;
  const missing=SHEET_NAMES.filter(n=>tabIds[n]===undefined);
  if(missing.length) throw new Error(`Google Sheets thiếu trang: ${missing.join(', ')}`);
  return {title:metadata.data.properties?.title || '',tabIds};
}

export async function readSnapshot():Promise<SheetSnapshot> {
  const {api,id}=sheetsClient();
  const {title,tabIds}=await verifySpreadsheet();
  const ranges=[sheetRef('NHẬP CẦN THU','A:ZZ'),sheetRef('NHẬT KÝ','A:M'),sheetRef('CÀI ĐẶT','A:M'),sheetRef('TÀI KHOẢN NHẬN','A:C'),sheetRef('PHÂN QUYỀN WEBAPP','A:J'),sheetRef('CẦN THU','B2')];
  const res=await api.spreadsheets.values.batchGet({spreadsheetId:id,ranges,valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});
  const [dueRaw,journalRaw,houseRaw,bankRaw,userRaw]=ranges.map((_,i)=>(res.data.valueRanges?.[i]?.values || []) as unknown[][]);
  if (!journalRaw) throw new Error('Không đọc được NHẬT KÝ');
  if(clean(journalRaw[0]?.[10]).normalize('NFC').toUpperCase()!=='MÃ GIAO DỊCH') throw new Error('NHẬT KÝ!K1 phải là Mã giao dịch; dừng đồng bộ ghi');
  // Blank L:M are allowed for old sheets; verify if populated with unexpected headers.
  for(const [i,expected] of [[11,'Ngày chuyển khoản'],[12,'Nội dung chuyển khoản']] as const) {
    const title=clean(journalRaw[0]?.[i]);
    if (title && title.normalize('NFC').toLowerCase()!==expected.toLowerCase()) throw new Error(`NHẬT KÝ!${i===11?'L':'M'}1 có tiêu đề khác`);
  }
  const {months,dues}=readDues(dueRaw);
  const journal=journalRaw.slice(1).map((row,i)=>readJournalSafely(row,i+2,id));
  const houses=houseRaw.slice(1).map((row,i)=>({code:key(row[0]),active:key(row[10])!=='NGỪNG DÙNG',name:clean(row[11]),note:clean(row[12]),row:i+2,fingerprint:fingerprint(row)})).filter(h=>h.code);
  const accounts=bankRaw.slice(1).map((row,i)=>({name:clean(row[0]),active:key(row[1])!=='NGỪNG DÙNG',note:clean(row[2]),row:i+2,fingerprint:fingerprint(row)})).filter(a=>a.name);
  const users=userRaw.slice(1).map(row=>({login:clean(row[0]),name:clean(row[1]),houses:clean(row[2]).split(',').map(key).filter(Boolean),accounts:clean(row[3]).split(',').map(clean).filter(Boolean),active:key(row[4])!=='NGỪNG DÙNG',role:key(row[5])==='ADMIN'?'ADMIN':'NV',legacySalt:clean(row[6])||null,legacyHash:clean(row[7])||null})).filter(u=>u.login);
  return {spreadsheetId:id,title,tabIds,months,dues,journal,rawJournal:journalRaw,
    houseNextRow:Math.max(2,houseRaw.length+1),accountNextRow:Math.max(2,bankRaw.length+1),houses,accounts,users};
}

export async function appendJournal(values:(string|number)[]):Promise<void>{
  const {api,id}=sheetsClient();
  await api.spreadsheets.values.append({spreadsheetId:id,range:sheetRef('NHẬT KÝ','A:M'),valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:[values]}});
}
export async function replaceJournalRow(row:number,values:(string|number)[]):Promise<void>{
  const {api,id}=sheetsClient();
  await api.spreadsheets.values.update({spreadsheetId:id,range:sheetRef('NHẬT KÝ',`A${row}:M${row}`),valueInputOption:'RAW',requestBody:{values:[values]}});
}
export async function deleteJournalRow(row:number,tabId:number):Promise<void>{
  const {api,id}=sheetsClient();
  await api.spreadsheets.batchUpdate({spreadsheetId:id,requestBody:{requests:[{deleteDimension:{range:{sheetId:tabId,dimension:'ROWS',startIndex:row-1,endIndex:row}}}]}});
}
export async function writeCatalog(kind:'house'|'account',row:number,value:{code?:string;name:string;note:string;active:boolean}):Promise<void>{
  const {api,id}=sheetsClient();
  if(kind==='house'){
    await api.spreadsheets.values.batchUpdate({spreadsheetId:id,requestBody:{valueInputOption:'RAW',data:[
      {range:sheetRef('CÀI ĐẶT',`A${row}`),values:[[value.code||'']]},
      {range:sheetRef('CÀI ĐẶT',`K${row}:M${row}`),values:[[value.active?'':'NGỪNG DÙNG',value.name,value.note]]},
    ]}});
  } else {
    await api.spreadsheets.values.update({spreadsheetId:id,range:sheetRef('TÀI KHOẢN NHẬN',`A${row}:C${row}`),valueInputOption:'RAW',requestBody:{values:[[value.name,value.active?'ĐANG DÙNG':'NGỪNG DÙNG',value.note]]}});
  }
}

export async function clearCatalog(kind:'house'|'account',row:number):Promise<void>{
  const {api,id}=sheetsClient();
  if(kind==='house'){
    await api.spreadsheets.values.batchClear({spreadsheetId:id,requestBody:{ranges:[
      sheetRef('CÀI ĐẶT',`A${row}`),
      sheetRef('CÀI ĐẶT',`K${row}:M${row}`),
    ]}});
  }else{
    await api.spreadsheets.values.clear({spreadsheetId:id,range:sheetRef('TÀI KHOẢN NHẬN',`A${row}:C${row}`)});
  }
}

export async function readJournalLive():Promise<unknown[][]>{
  const {api,id}=sheetsClient();
  const res=await api.spreadsheets.values.get({spreadsheetId:id,range:sheetRef('NHẬT KÝ','A:M'),valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'});
  return (res.data.values||[]) as unknown[][];
}
