#!/usr/bin/env node
/** BUYER AGENT v6 — Text + Image. Text via VPS DeepSeek. Image via Zaitek SCZ with inbox delivery. */
try{require('ethers')}catch(e){const{execSync}=require('child_process');console.log('Installing ethers...');execSync('npm install ethers@5.7',{cwd:__dirname,stdio:'inherit'})}
const ethers=require('ethers'),crypto=require('crypto'),path=require('path'),fs=require('fs'),readline=require('readline'),http=require('http'),https=require('https');
const E6=ethers.version?.startsWith('6'),signTD=(w,d,t,m)=>E6?w.signTypedData(d,t,m):w._signTypedData(d,t,m),fU=(v,d)=>E6?ethers.formatUnits(v,d):ethers.utils.formatUnits(v,d),fE=v=>E6?ethers.formatEther(v):ethers.utils.formatEther(v),mkP=u=>E6?new ethers.JsonRpcProvider(u):new ethers.providers.JsonRpcProvider(u);
const API='https://api.santaclawz.ai',RPC='https://mainnet.base.org',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',VPS='http://194.163.187.163:3003',INBOX='http://194.163.187.163:8796';
function norm(o){if(Array.isArray(o))return o.map(norm);if(o&&typeof o==='object')return Object.fromEntries(Object.entries(o).filter(([,n])=>n!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,n])=>[k,norm(n)]));if(typeof o==='bigint')return o.toString();return o}
function dlUrl(u){return new Promise((r,j)=>{const m=u.startsWith('https')?https:http;m.get(u,{timeout:60000},s=>{const c=[];s.on('data',d=>c.push(d));s.on('end',()=>r(Buffer.concat(c)))}).on('error',j).on('timeout',function(){this.destroy();j(new Error('timeout'))})})}

async function generateText(task,dir){
  console.log('   📡 VPS: /api/generate (DeepSeek)');
  const data=JSON.stringify({prompt:task,jobId:path.basename(dir)});
  return new Promise((r,j)=>{
    const req=http.request({hostname:'194.163.187.163',port:3003,path:'/api/generate',method:'POST',timeout:180000,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},async res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',async()=>{
        try{const p=JSON.parse(d);if(res.statusCode>=200&&res.statusCode<300&&p.status==='completed'){
          const files=p.files||[],downloaded=[];
          for(const f of files){const url=f.download_url||f.url||'';if(url){try{console.log(`   📥 ${f.name}...`);const buf=await dlUrl(url);fs.writeFileSync(path.join(dir,f.name),buf);downloaded.push({name:f.name,path:path.join(dir,f.name),size:buf.length})}catch(e){console.log(`   ⚠️ ${f.name}: ${e.message}`)}}}
          r({files:downloaded,textOutput:p.output_text||'',success:true})
        }else j(new Error(p.error||`VPS ${res.statusCode}`))
        }catch(e){j(new Error(`Parse: ${d.slice(0,100)}`))}
      })
    });req.on('error',j);req.on('timeout',()=>{req.destroy();j(new Error('VPS timeout'))});req.write(data);req.end()
  })
}

async function hireImage(task,wallet,usdc,dir){
  const AGENT='zaitek-technologies--session_agent_b4a646d96b37';
  console.log('   📡 SCZ: Zaitek Technologies ($1.00)');

  const pf=await(await fetch(API+'/api/agents/'+AGENT+'/hire',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskPrompt:task,requesterContact:'buyer:'+wallet.address,artifactDelivery:{mode:'direct_receipt',buyerInboxUrl:INBOX+'/deliver'}})})).json();
  const accept=pf.accepts?.[0];if(!accept)throw new Error(pf.error||'No accept');
  console.log('   ✅ Preflight — requestId:',pf.requestId);

  const fees=accept.extensions.evm.feeSplit,vb=BigInt(Math.floor(Date.now()/1000)+3600);
  const dom={name:'USD Coin',version:'2',chainId:8453,verifyingContract:USDC};
  const types={TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]};
  const sn='0x'+crypto.randomBytes(32).toString('hex'),sm={from:wallet.address,to:fees.sellerPayTo,value:BigInt(fees.sellerAmount),validAfter:0n,validBefore:vb,nonce:sn};
  const ss=await signTD(wallet,dom,types,sm),sp=E6?ethers.Signature.from(ss):ethers.utils.splitSignature(ss);
  const pn='0x'+crypto.randomBytes(32).toString('hex'),pm={from:wallet.address,to:fees.protocolFeePayTo,value:BigInt(fees.protocolFeeAmount),validAfter:0n,validBefore:vb,nonce:pn};
  const ps=await signTD(wallet,dom,types,pm),pp=E6?ethers.Signature.from(ps):ethers.utils.splitSignature(ps);
  const payload={protocol:'x402',networkId:'eip155:8453',settlementRail:'evm',requestId:pf.requestId,payTo:accept.payTo,paymentId:'pay_'+crypto.randomBytes(16).toString('hex'),issuedAtIso:new Date().toISOString(),expiresAtIso:new Date(Date.now()+3600000).toISOString(),amount:accept.price,asset:accept.asset,scheme:'exact',extensions:{evm:{amountUnit:'atomic'}},authorization:{typedData:{domain:dom,types,message:sm},signature:ss},accepted:{network:'eip155:8453',payTo:accept.payTo,asset:USDC,amount:accept.price,extra:{feeSplit:{grossAmount:String(fees.grossAmount||''),sellerAmount:String(fees.sellerAmount),protocolFeeAmount:String(fees.protocolFeeAmount),protocolFeePayTo:fees.protocolFeePayTo,sellerPayTo:fees.sellerPayTo,feeBps:fees.feeBps}}},payload:{signature:ss,authorization:{from:wallet.address,to:fees.sellerPayTo,value:String(fees.sellerAmount),validAfter:'0',validBefore:vb.toString(),nonce:sn,v:'0x'+sp.v.toString(16),r:sp.r,s:sp.s},feeAuthorization:{signature:ps,authorization:{from:wallet.address,to:fees.protocolFeePayTo,value:String(fees.protocolFeeAmount),validAfter:'0',validBefore:vb.toString(),nonce:pn,v:'0x'+pp.v.toString(16),r:pp.r,s:pp.s}}},feeAuthorization:{typedData:{domain:dom,types,message:pm},signature:ps},resource:{url:pf.resource,description:'Image hire',mimeType:'application/json'}};
  payload.authorizationDigest=crypto.createHash('sha256').update(JSON.stringify(norm(payload))).digest('hex');

  try{const tx=await usdc.transferWithAuthorization(wallet.address,fees.protocolFeePayTo,BigInt(fees.protocolFeeAmount),0n,vb,pn,pp.v,pp.r,pp.s);await tx.wait()}catch(e){}
  const res=await(await fetch(API+'/api/agents/'+AGENT+'/hire',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskPrompt:task,requesterContact:'buyer:'+wallet.address,artifactDelivery:{mode:'direct_receipt',buyerInboxUrl:INBOX+'/deliver'},paymentPayload:payload},(k,v)=>typeof v==='bigint'?v.toString():v)})).json();
  console.log('   ✅ Status:',res.status,'| Payment:',res.paymentStatus);

  // Poll inbox for up to 60s
  console.log('   ⏳ Waiting for image in inbox...');
  let got=false;
  for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,5000));
    try{
      const d=await(await fetch(INBOX+'/deliveries')).json();
      if(d&&d.length>0){
        const last=d[d.length-1];
        if(last.seller==='zaitek'&&last.files&&last.files.length>0){
          for(const f of last.files){
            try{
              const buf=await dlUrl(`http://194.163.187.163:8796/file/${last.delivery_id}/${f.filename}`);
              if(buf.length>100){
                const fp=path.join(dir,f.filename);
                fs.writeFileSync(fp,buf);
                console.log(`   ✅ ${f.filename} (${(buf.length/1024).toFixed(1)} KB)`);
                got=true;
              }
            }catch(e){}
          }
          if(got)break;
        }
      }
    }catch(e){}
  }
  if(!got)console.log('   ⚠️ No file in inbox');
  return got;
}

async function main(){
  console.log(`\n╔═══════════════════════════════════════════════╗\n║  BUYER AGENT v6 — Text + Image              ║\n║  Text: VPS DeepSeek (free)                  ║\n║  Image: Zaitek via SCZ ($1.00 + gas)        ║\n╚═══════════════════════════════════════════════╝\n`);
  const rl=readline.createInterface({input:process.stdin,output:process.stdout}),q=q=>new Promise(r=>rl.question(q,r));
  let pk=process.env.BUYER_PK||'';if(!pk){pk=(await q('🔐 Private key (0x...): ')).trim();if(!pk.startsWith('0x'))pk='0x'+pk}
  const provider=mkP(RPC);let wallet;try{wallet=new ethers.Wallet(pk,provider)}catch(e){console.log('❌ Invalid key');process.exit(1)}
  console.log('👤',wallet.address);
  const usdc=new ethers.Contract(USDC,['function balanceOf(address) view returns (uint256)','function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external'],wallet);
  let bal,eth;try{bal=await usdc.balanceOf(wallet.address);eth=await provider.getBalance(wallet.address)}catch(e){console.log('❌ RPC');process.exit(1)}
  console.log('💰 USDC: $'+fU(bal,6)+' | ETH: '+fE(eth).substring(0,8));
  const outDir=path.join(process.cwd(),'output');fs.mkdirSync(outDir,{recursive:true});
  console.log('\n┌───────────────────────────────────────────────┐\n│ Text tasks → VPS (free)                       │\n│ Image tasks → Zaitek SCZ ($1.00 + gas)        │\n│ Examples:                                     │\n│   "article on PH crypto" → text               │\n│   "create image of cat in space" → image      │\n│   "write report + generate image" → both      │\n└───────────────────────────────────────────────┘\n');
  let running=true;
  while(running){
    const input=(await q('> ')).trim();const c=input.toLowerCase();
    if(!input)continue;if(/^(quit|exit|q)$/.test(c)){console.log('👋 Bye!');running=false;break}
    if(c==='balance'){console.log('💰 $'+fU(await usdc.balanceOf(wallet.address),6));continue}
    const dir=path.join(outDir,Date.now().toString(36)+'_task');fs.mkdirSync(dir,{recursive:true});
    const needsImage=/image|picture|photo|generate|draw|illustrate|art|graphic|design|poster|banner|logo|meme|visual|infographic|artwork/i.test(c);
    const needsText=/article|blog|news|research|report|write|content|story|website|analysis|summary|explain|describe|list|top.*10|trending|market|review/i.test(c);

    if(needsImage&&!needsText){
      // Pure image
      const balN=parseFloat(fU(await usdc.balanceOf(wallet.address),6));
      if(balN<1){console.log('❌ Need $1.00 for Zaitek, have $'+balN.toFixed(2));continue}
      console.log('\n🖼️ Image via Zaitek ($1.00)');
      try{await hireImage(input,wallet,usdc,dir);bal=await usdc.balanceOf(wallet.address);console.log('💰 $'+fU(bal,6))}catch(e){console.log('❌',e.message)}
    }else if(needsText&&needsImage){
      // Both: text first (free), then image
      console.log('\n📝 Text via VPS...');
      try{const r=await generateText(input,dir);if(r.files.length>0)for(const f of r.files){const s=f.size>1024?(f.size/1024).toFixed(1)+' KB':f.size+' B';console.log(`   📄 ${f.name} (${s})`)}}catch(e){console.log('   ⚠️ Text:',e.message)}
      const balN=parseFloat(fU(await usdc.balanceOf(wallet.address),6));
      if(balN>=1){
        console.log('\n🖼️ Image via Zaitek ($1.00)');
        try{await hireImage(input,wallet,usdc,dir);bal=await usdc.balanceOf(wallet.address);console.log('💰 $'+fU(bal,6))}catch(e){console.log('   ⚠️ Image:',e.message)}
      }else console.log('   ⚠️ Not enough USDC for image ($'+balN.toFixed(2)+')')
    }else{
      // Text only
      console.log('\n📝 VPS: generating...');
      try{const r=await generateText(input,dir);if(r.files.length>0){console.log('✅ Done');
        for(const f of r.files){const e=path.extname(f.name).toLowerCase(),s=f.size>1024?(f.size/1024).toFixed(1)+' KB':f.size+' B';console.log(`   📄 ${f.name} (${s})`)}}else console.log('   ⚠️ No files')}catch(e){console.log('❌',e.message)}
    }
    console.log()
  }
  rl.close()
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1)});
