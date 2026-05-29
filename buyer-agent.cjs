#!/usr/bin/env node
/** BUYER AGENT v5 — Text-only via DeepSeek on VPS */
try{require('ethers')}catch(e){const{execSync}=require('child_process');console.log('📦 Installing ethers.js...');execSync('npm install ethers@5.7',{cwd:__dirname,stdio:'inherit'})}
const ethers=require('ethers'),crypto=require('crypto'),path=require('path'),fs=require('fs'),readline=require('readline'),http=require('http'),https=require('https');
const E6=ethers.version?.startsWith('6'),signTD=(w,d,t,m)=>E6?w.signTypedData(d,t,m):w._signTypedData(d,t,m),fU=(v,d)=>E6?ethers.formatUnits(v,d):ethers.utils.formatUnits(v,d),fE=v=>E6?ethers.formatEther(v):ethers.utils.formatEther(v),mkP=u=>E6?new ethers.JsonRpcProvider(u):new ethers.providers.JsonRpcProvider(u);
const API_BASE='https://api.santaclawz.ai',BASE_RPC='https://mainnet.base.org',USDC_ADDR='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',VPS='http://194.163.187.163:3003';
function downloadUrl(u){return new Promise((r,j)=>{const m=u.startsWith('https')?https:http;m.get(u,{timeout:60000},(s)=>{const c=[];s.on('data',d=>c.push(d));s.on('end',()=>r(Buffer.concat(c)))}).on('error',j).on('timeout',function(){this.destroy();j(new Error('timeout'))})})}
async function generateOnVPS(task,dir){console.log('   📡 VPS: /api/generate (DeepSeek)');return new Promise((resolve,reject)=>{
  const data=JSON.stringify({prompt:task,jobId:path.basename(dir)});
  const req=http.request({hostname:'194.163.187.163',port:3003,path:'/api/generate',method:'POST',timeout:180000,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},(res)=>{
    let d='';res.on('data',c=>d+=c);res.on('end',async()=>{
      try{const r=JSON.parse(d);if(res.statusCode>=200&&res.statusCode<300&&r.status==='completed'){
        const files=r.files||[],downloaded=[];
        for(const f of files){const url=f.download_url||f.url||'';
          if(url){try{console.log(`   📥 ${f.name}...`);const buf=await downloadUrl(url);fs.writeFileSync(path.join(dir,f.name),buf);downloaded.push({name:f.name,path:path.join(dir,f.name),size:buf.length})}catch(e){console.log(`   ⚠️ ${f.name}: ${e.message}`)}}
          else console.log(`   ⚠️ ${f.name}: no URL`)}
        resolve({files:downloaded,textOutput:r.output_text||'',success:true})
      }else reject(new Error(r.error||`VPS ${res.statusCode}`))
      }catch(e){reject(new Error(`Parse: ${d.slice(0,100)}`))}
    })
  });req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('VPS timeout'))});req.write(data);req.end()
})}
async function main(){
  console.log(`\n╔═══════════════════════════════════════════╗\n║  BUYER AGENT v5 — Text via DeepSeek    ║\n║  Calls VPS dashboard (free, no Grok)    ║\n╚═══════════════════════════════════════════╝\n`);
  const rl=readline.createInterface({input:process.stdin,output:process.stdout}),q=q=>new Promise(r=>rl.question(q,r));
  let pk=process.env.BUYER_PK||'';if(!pk){pk=(await q('🔐 Private key (0x...): ')).trim();if(!pk.startsWith('0x'))pk='0x'+pk}
  const provider=mkP(BASE_RPC);let wallet;try{wallet=new ethers.Wallet(pk,provider)}catch(e){console.log('❌ Invalid key');process.exit(1)}
  console.log(`👤 ${wallet.address}`);
  const usdc=new ethers.Contract(USDC_ADDR,['function balanceOf(address) view returns (uint256)'],provider);
  let bal,eth;try{bal=await usdc.balanceOf(wallet.address);eth=await provider.getBalance(wallet.address)}catch(e){console.log('❌ RPC');process.exit(1)}
  console.log(`💰 USDC: $${fU(bal,6)} | ETH: ${fE(eth).substring(0,8)}`);
  const outDir=path.join(process.cwd(),'output');fs.mkdirSync(outDir,{recursive:true});
  console.log('\n┌──────────────────────────────────────┐\n│ Type a task or: quit | balance          │\n│ Text-only (DeepSeek on VPS)             │\n└──────────────────────────────────────┘\n');
  let running=true;
  while(running){
    const input=(await q('> ')).trim();const c=input.toLowerCase();
    if(!input)continue;if(/^(quit|exit|q)$/.test(c)){console.log('👋 Bye!');running=false;break}
    if(c==='balance'){console.log(`💰 $${fU(await usdc.balanceOf(wallet.address),6)}`);continue}
    const dir=path.join(outDir,`${Date.now().toString(36)}_task`);fs.mkdirSync(dir,{recursive:true});
    console.log(`\n🆓 VPS: generating...`);
    try{const r=await generateOnVPS(input,dir);
      if(r.files.length>0){console.log(`\n✅ Done — ${r.files.length} file(s) in ${dir}`);
        for(const f of r.files){const e=path.extname(f.name).toLowerCase();const i=['.md','.txt'].includes(e)?'📄':'📎';const s=f.size>1024?`${(f.size/1024).toFixed(1)} KB`:`${f.size} B`;console.log(`   ${i} ${f.name} (${s})`)}
      }else console.log('   ⚠️ No files returned')
    }catch(e){console.log(`   ❌ ${e.message}`)}
    console.log()
  }
  rl.close()
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1)});
