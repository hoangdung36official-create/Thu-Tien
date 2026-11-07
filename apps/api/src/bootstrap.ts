import argon2 from 'argon2';
import { env } from './env.js';
import { db } from './db.js';
import { assertBinding } from './sync.js';

if(!env.INITIAL_ADMIN_LOGIN||!/^\+?\d{9,15}$/.test(env.INITIAL_ADMIN_LOGIN)||!env.INITIAL_ADMIN_PASSWORD||env.INITIAL_ADMIN_PASSWORD.length<10){
  throw new Error('Cấu hình INITIAL_ADMIN_LOGIN là số điện thoại và INITIAL_ADMIN_PASSWORD ít nhất 10 ký tự');
}
if(env.GOOGLE_SPREADSHEET_ID) await assertBinding();
const existing=await db.user.findUnique({where:{login:env.INITIAL_ADMIN_LOGIN}});
if(existing?.passwordHash){
  if(!process.argv.includes('--if-missing')) throw new Error('Quản trị viên đã có mật khẩu; sử dụng giao diện quản trị để thay đổi');
  console.info('Quản trị viên đã có mật khẩu; giữ nguyên khi tái triển khai.');
  await db.$disconnect();
  process.exit(0);
}
const passwordHash=await argon2.hash(env.INITIAL_ADMIN_PASSWORD,{type:argon2.argon2id});
const user=await db.user.upsert({where:{login:env.INITIAL_ADMIN_LOGIN},create:{login:env.INITIAL_ADMIN_LOGIN,name:'Quản trị Vincent',role:'ADMIN',active:true,passwordHash},
  update:{role:'ADMIN',active:true,passwordHash,sessionVersion:{increment:1}}});
console.info(`Đã kích hoạt quản trị viên ${user.login}. Không in mật khẩu.`);
await db.$disconnect();
process.exit(0);
