import PDFDocument from 'pdfkit';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { env } from './env.js';
import { dayText } from './business.js';
import type { BankAccount, Receipt } from '@prisma/client';

export type ReportGroup={account:BankAccount;receipts:Receipt[];total:bigint};
export const currency=(n:bigint)=>`${new Intl.NumberFormat('vi-VN').format(n)} đ`;
const dateRange=(r:{month?:string;from?:string;to?:string})=>[r.month?`Tháng thu ${r.month}`:'Tất cả kỳ thu',r.from?`Từ ${r.from}`:'',r.to?`Đến ${r.to}`:''].filter(Boolean).join(' · ');

export async function makePdf(groups:ReportGroup[],filter:{month?:string;from?:string;to?:string}){
  const doc=new PDFDocument({size:'A4',layout:'landscape',margin:35,bufferPages:true,info:{Title:'Vincent · Báo cáo chuyển khoản',Author:'Vincent'}});
  const parts:Buffer[]=[];
  const finished=new Promise<Buffer>((resolve,reject)=>{doc.on('data',(b:Buffer)=>parts.push(b));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject)});
  const font=env.PDF_FONT_PATH||'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const bold=env.PDF_FONT_BOLD_PATH||'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  doc.registerFont('normal',font).registerFont('bold',bold);
  const w=doc.page.width-70, cols=[34,100,82,58,365,132], starts=cols.map((_,i)=>35+cols.slice(0,i).reduce((a,b)=>a+b,0));
  const labels=['STT','Ngày chuyển','Tòa nhà','Phòng','Nội dung chuyển khoản','Số tiền'];
  function header(){
    doc.font('bold').fontSize(17).fillColor('#142b40').text('VINCENT  /  BÁO CÁO CHUYỂN KHOẢN',35,36);
    doc.font('normal').fontSize(9).fillColor('#5d6875').text(dateRange(filter),35,64);
    doc.moveTo(35,84).lineTo(35+w,84).lineWidth(.7).stroke('#cad3db');
    doc.y=95;
  }
  function tableHeader(){
    const y=doc.y;
    doc.rect(35,y,w,24).fill('#edf2f5');
    labels.forEach((t,i)=>doc.font('bold').fontSize(8).fillColor('#324558').text(t,starts[i]+4,y+6,{width:cols[i]-8}));
    doc.y=y+29;
  }
  function newPage(){doc.addPage();header();tableHeader();}
  header();
  let grand=0n;
  for(let g=0;g<groups.length;g++){
    const group=groups[g];grand+=group.total;
    if(doc.y>doc.page.height-155) {doc.addPage();header();}
    doc.font('bold').fontSize(12).fillColor('#142b40').text(`${g+1}. ${group.account.name}`,35,doc.y+10);
    doc.font('normal').fontSize(9).fillColor('#566676').text(`Chủ tài khoản: ${group.account.owner||'Chưa cập nhật'}   |   Ngân hàng: ${group.account.bank||'Chưa cập nhật'}   |   Số tài khoản: ${group.account.number||'Chưa cập nhật'}`,35,doc.y+6,{width:w});
    doc.y+=10;
    tableHeader();
    for(let i=0;i<group.receipts.length;i++){
      const r=group.receipts[i];
      const fields=[String(i+1),dayText(r.transferAt),r.houseCode,r.room,r.transferMemo||'—',currency(r.amount)];
      let remaining=fields.slice(),part=0;
      // A single transfer memo may be longer than one page. Split each
      // column into measured fragments so that none is silently clipped.
      do {
        if(doc.y+25>doc.page.height-62)newPage();
        doc.font('normal').fontSize(8);
        const available=doc.page.height-62-doc.y-12;
        const fragments=remaining.map((value,j)=>{
          if(!value)return '';
          const options={width:cols[j]-8,align:j===5?'right' as const:'left' as const};
          if(doc.heightOfString(value,options)<=available)return value;
          const chars=Array.from(value);
          let low=0,high=chars.length;
          while(low<high){
            const mid=Math.ceil((low+high)/2);
            if(doc.heightOfString(chars.slice(0,mid).join(''),options)<=available)low=mid;
            else high=mid-1;
          }
          return chars.slice(0,Math.max(1,low)).join('');
        });
        const rowH=Math.max(25,...fragments.map((v,j)=>v?doc.heightOfString(v,{width:cols[j]-8,align:j===5?'right':'left'})+12:0));
        if(doc.y+rowH>doc.page.height-62){newPage();continue;}
        const y=doc.y;
        if(i%2)doc.rect(35,y,w,rowH).fill('#f7f9fb');
        fragments.forEach((v,j)=>doc.font('normal').fontSize(8).fillColor('#203346').text(v,starts[j]+4,y+6,{width:cols[j]-8,align:j===5?'right':'left'}));
        doc.y=y+rowH;
        doc.moveTo(35,doc.y).lineTo(35+w,doc.y).lineWidth(.3).stroke('#d7dfe5');
        remaining=remaining.map((v,j)=>v.slice(fragments[j].length));
        part++;
      } while(remaining.some(Boolean)||part===0);
    }
    if(doc.y+35>doc.page.height-62) newPage();
    doc.font('bold').fontSize(10).fillColor('#14354d').text(`${group.receipts.length} giao dịch  ·  Tổng nhận: ${currency(group.total)}`,35,doc.y+12,{align:'right',width:w});
    doc.y+=35;
  }
  if(doc.y+52>doc.page.height-62) {doc.addPage();header();}
  doc.moveTo(35,doc.y).lineTo(35+w,doc.y).stroke('#7d97ad');
  doc.font('bold').fontSize(13).fillColor('#153b56').text(`TỔNG CỘNG: ${currency(grand)}`,35,doc.y+11,{align:'right',width:w});
  const count=doc.bufferedPageRange().count;
  for(let i=0;i<count;i++){
    doc.switchToPage(i);
    doc.font('normal').fontSize(8).fillColor('#697886').text(`Vincent  •  Xuất lúc ${new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'short'}).format(new Date())}    |    Trang ${i+1}/${count}`,35,doc.page.height-35,{width:w,align:'right'});
  }
  doc.end();
  return await finished;
}

export async function makeZip(groups:ReportGroup[],filter:{month?:string;from?:string;to?:string}) {
  const output=new PassThrough(),zip=archiver('zip',{zlib:{level:7}}),parts:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{output.on('data',(b:Buffer)=>parts.push(b));output.on('end',()=>resolve(Buffer.concat(parts)));output.on('error',reject);zip.on('error',reject)});
  zip.pipe(output);
  for(let i=0;i<groups.length;i++){
    const g=groups[i];
    const file=`${String(i+1).padStart(2,'0')}-${g.account.name.replace(/[^a-zA-Z0-9À-ỹ_-]/g,'_').slice(0,45)}.pdf`;
    zip.append(await makePdf([g],filter),{name:file});
  }
  await zip.finalize();
  return await done;
}
