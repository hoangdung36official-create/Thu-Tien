import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const db = new PrismaClient();
export const keyScope = `vincent:${env.GOOGLE_SPREADSHEET_ID}:`;

export async function acquireLease(key:string,token:string,ttlMs:number){
  const expiresAt=new Date(Date.now()+ttlMs);
  const changed=await db.$executeRaw`
    INSERT INTO "Lease" ("key","token","expiresAt","updatedAt")
    VALUES (${key},${token},${expiresAt},CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO UPDATE SET
      "token"=EXCLUDED."token",
      "expiresAt"=EXCLUDED."expiresAt",
      "updatedAt"=CURRENT_TIMESTAMP
    WHERE "Lease"."expiresAt" <= CURRENT_TIMESTAMP OR "Lease"."token"=${token}
  `;
  return changed===1;
}

export async function renewLease(key:string,token:string,ttlMs:number){
  const result=await db.lease.updateMany({
    where:{key,token,expiresAt:{gt:new Date()}},
    data:{expiresAt:new Date(Date.now()+ttlMs)},
  });
  return result.count===1;
}

export async function releaseLease(key:string,token:string){
  await db.lease.deleteMany({where:{key,token}});
}
