import { Queue, Worker } from 'bullmq';
import { db, redis, keyScope } from './db.js';
import { env } from './env.js';
import { runSyncCycle } from './sync.js';

const name=keyScope+'sheet-sync';
const queue=new Queue(name,{connection:redis});
await queue.upsertJobScheduler('periodic',{every:env.SHEET_POLL_SECONDS*1000},{name:'pull-push',data:{}});
await queue.add('pull-push',{}, {jobId:'startup',removeOnComplete:true,removeOnFail:20});
const worker=new Worker(name,async()=>{
  try{
    const result=await runSyncCycle();
    await db.syncState.upsert({where:{key:'lastError'},create:{key:'lastError',value:''},update:{value:''}});
    return result;
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    await db.syncState.upsert({where:{key:'lastError'},create:{key:'lastError',value:message},update:{value:message}});
    throw e;
  }
},{connection:redis,concurrency:1,lockDuration:10*60000});
worker.on('failed',(job,error)=>console.error('Đồng bộ Sheets lỗi',job?.id,error.message));
worker.on('completed',(job,value)=>console.info('Đồng bộ Sheets',job.id,value));
async function stop(){await worker.close();await queue.close();await redis.quit();await db.$disconnect();}
process.on('SIGINT',()=>{void stop().then(()=>process.exit(0));});
process.on('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
