#!/usr/bin/env node
/**
 * BUYER AGENT v4 — Hybrid VPS+SCZ
 * Uses our VPS dashboard for text/image (free, fast, multi-file)
 * Falls back to SCZ hired agents only when needed (audit, etc.)
 * Usage: node buyer-agent.cjs
 */

try { require('ethers'); } catch(e) {
  const { execSync } = require('child_process');
  console.log('📦 Installing ethers.js (one-time)...');
  execSync('npm install ethers@5.7', { stdio:'inherit', cwd:__dirname });
}

const ethers = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const http = require('http');
const https = require('https');

const E6 = ethers.version?.startsWith('6');
const signTD = (w,d,t,m) => E6 ? w.signTypedData(d,t,m) : w._signTypedData(d,t,m);
const parseS = (s) => E6 ? ethers.Signature.from(s) : ethers.utils.splitSignature(s);
const fU = (v,d) => E6 ? ethers.formatUnits(v,d) : ethers.utils.formatUnits(v,d);
const fE = (v) => E6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const mkP = (u) => E6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v==='object') return Object.fromEntries(Object.entries(v).filter(([,n])=>n!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,n])=>[k,norm(n)]));
  return v;
}
function canonDig(p) { const j=JSON.stringify(norm(p)); return {stableJson:j,sha256Hex:crypto.createHash('sha256').update(j,'utf-8').digest('hex')}; }
function js(o) { if(typeof o==='bigint')return o.toString(); if(Array.isArray(o))return o.map(js); if(o&&typeof o==='object'){const r={};for(const[k,v]of Object.entries(o))r[k]=js(v);return r}return o; }

const API_BASE = 'https://api.santaclawz.ai';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VPS = 'http://194.163.187.163:3003';

// ─── VPS Direct API calls (FREE, fast, multi-file) ───
function vpsPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname:'194.163.187.163', port:3003, path:endpoint,
      method:'POST', timeout:180000,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}
    };
    const req = http.request(opts, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve({status:res.statusCode,data:JSON.parse(d)});}catch{resolve({status:res.statusCode,data:{raw:d}});} });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('VPS timeout'));});
    req.write(data); req.end();
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https')?https:http;
    mod.get(url,{timeout:60000},(res)=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve(Buffer.concat(c)));})
      .on('error',reject).on('timeout',function(){this.destroy();reject(new Error('timeout'));});
  });
}

// ─── TASK ANALYZER ───
function analyze(task) {
  const t = task.toLowerCase();
  const needsResearch = /article|blog|news|research|report|write|content|story|website|top.*list|trending|summary|crypto|market/i.test(t);
  const needsImage = /image|picture|photo|generate|draw|illustrate|art|graphic|design|poster|banner|logo|meme|visual|infographic|artwork/i.test(t);
  const needsAudit = /audit|smart contract|solidity|vulnerability|reentrancy|exploit|security.*review/i.test(t);
  return { needsResearch, needsImage, needsAudit };
}

// ─── VPS GENERATION (free) ───
async function generateOnVPS(task, jobDir) {
  const type = analyze(task);
  let endpoint, body;

  if (type.needsImage && type.needsResearch) {
    // Text + Image: use unified /api/generate (does both)
    endpoint = '/api/generate';
    body = { prompt: task, jobId: path.basename(jobDir) };
    console.log('   📡 VPS: /api/generate (text + image)');
  } else if (type.needsImage) {
    // Image only
    endpoint = '/api/generate-image';
    body = { prompt: task, jobId: path.basename(jobDir), includeDescription: true };
    console.log('   📡 VPS: /api/generate-image (image + description)');
  } else {
    // Text only
    endpoint = '/api/generate';
    body = { prompt: task, jobId: path.basename(jobDir) };
    console.log('   📡 VPS: /api/generate (text document)');
  }

  const result = await vpsPost(endpoint, body);
  if (result.status >= 200 && result.status < 300 && result.data?.status === 'completed') {
    const files = result.data.files || [];
    const downloaded = [];
    for (const f of files) {
      const src = f.local_path || '';
      if (src && fs.existsSync(src)) {
        const buf = fs.readFileSync(src);
        const dest = path.join(jobDir, f.name);
        fs.writeFileSync(dest, buf);
        downloaded.push({ name: f.name, path: dest, size: buf.length });
      } else if (f.url) {
        try {
          const buf = await downloadUrl(f.url);
          const dest = path.join(jobDir, f.name);
          fs.writeFileSync(dest, buf);
          downloaded.push({ name: f.name, path: dest, size: buf.length });
        } catch(e) { console.log(`   ⚠️ Download ${f.name} failed: ${e.message}`); }
      }
    }
    const text = result.data.output_text || '';
    return { files: downloaded, textOutput: text, success: true };
  }
  throw new Error(result.data?.error || `VPS returned ${result.status}`);
}

// ─── SCZ HIRE ENGINE ───
const AGENTS = [
  { name:'Zaitek Technologies', id:'zaitek-technologies--session_agent_b4a646d96b37', price:1.00 },
  { name:'zaiclaw', id:'zaiclaw--session_agent_1ef352f6cda1', price:0.25 },
  { name:'Code Audit Agent', id:'code-audit-agent--session_agent_51a8f5e04659', price:1.00 },
];

async function hireSCZ(agent, task, wallet, usdc) {
  const pf = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({taskPrompt:task, requesterContact:`buyer:${wallet.address}`})
  });
  const hr = await pf.json();
  const accept = hr.accepts?.[0];
  if (!accept) throw new Error(hr.error||'no accept');

  const fees = accept.extensions?.evm?.feeSplit;
  const rid = hr.requestId;
  const sAmt = BigInt(fees.sellerAmount);
  const pAmt = BigInt(fees.protocolFeeAmount);
  const sPay = fees.sellerPayTo;
  const pPay = fees.protocolFeePayTo;
  const vb = BigInt(Math.floor(Date.now()/1000)+3600);
  const dom = { name:'USD Coin', version:'2', chainId:8453, verifyingContract:USDC_ADDR };
  const types = { TransferWithAuthorization:[
    { name:'from', type:'address' }, { name:'to', type:'address' },
    { name:'value', type:'uint256' }, { name:'validAfter', type:'uint256' },
    { name:'validBefore', type:'uint256' }, { name:'nonce', type:'bytes32' },
  ]};

  const sn = '0x'+crypto.randomBytes(32).toString('hex');
  const sm = { from:wallet.address, to:sPay, value:sAmt, validAfter:0n, validBefore:vb, nonce:sn };
  const ss = await signTD(wallet, dom, types, sm);
  const sp = parseS(ss);

  const pn = '0x'+crypto.randomBytes(32).toString('hex');
  const pm = { from:wallet.address, to:pPay, value:pAmt, validAfter:0n, validBefore:vb, nonce:pn };
  const ps = await signTD(wallet, dom, types, pm);
  const pp = parseS(ps);

  const amt = accept.price;
  const pid = 'pay_'+crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const payload = {
    protocol:'x402', networkId:'eip155:8453', settlementRail:'evm',
    requestId:rid, payTo:accept.payTo, paymentId:pid,
    issuedAtIso:now.toISOString(), expiresAtIso:new Date(now.getTime()+3600000).toISOString(),
    amount:amt, asset:accept.asset, scheme:'exact',
    extensions:{ evm:{ amountUnit:'atomic' } },
    authorization:{ typedData:{ domain:dom, types, message:sm }, signature:ss },
    accepted:{
      network:'eip155:8453', payTo:accept.payTo, asset:USDC_ADDR, amount:amt,
      extra:{ feeSplit:{ grossAmount:amt, sellerAmount:fees.sellerAmount, protocolFeeAmount:fees.protocolFeeAmount, protocolFeePayTo:fees.protocolFeePayTo, protocolFeePayToLabel:'SantaClawz Protocol Fee', protocolFeeRecipient:fees.protocolFeePayTo, sellerPayTo:fees.sellerPayTo, feeSettlementMode:'exact-eip3009-split-v1', version:'protocol-owner-fee-v1', feeBps:fees.feeBps } }
    },
    payload:{ signature:ss, authorization:{ from:wallet.address, to:sPay, value:sAmt.toString(), validAfter:'0', validBefore:vb.toString(), nonce:sn, v:'0x'+sp.v.toString(16), r:sp.r, s:sp.s }, feeAuthorization:{ signature:ps, authorization:{ from:wallet.address, to:pPay, value:pAmt.toString(), validAfter:'0', validBefore:vb.toString(), nonce:pn, v:'0x'+pp.v.toString(16), r:pp.r, s:pp.s } } },
    feeAuthorization:{ typedData:{ domain:dom, types, message:pm }, signature:ps },
    resource:{ url:hr.resource, description:'SantaClawz agent hire', mimeType:'application/json' },
  };

  const { sha256Hex: ad } = canonDig(js(payload));
  payload.authorizationDigest = ad;

  try {
    const tx = await usdc.transferWithAuthorization(wallet.address, pPay, pAmt, 0n, vb, pn, pp.v, pp.r, pp.s);
    await tx.wait();
  } catch(e) {
    try { const tx2=await usdc.transferWithAuthorization(wallet.address,pPay,pAmt,0n,vb,pn,pp.v,pp.r,pp.s,{gasLimit:100000}); await tx2.wait(); } catch(e2) {}
  }

  const body = { taskPrompt:task, requesterContact:`buyer:${wallet.address}`, paymentPayload:payload };
  const res = await fetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(js(body)),
  });
  const data = await res.json().catch(()=>({}));
  if (res.status>=400) throw new Error(data.error||`HTTP ${res.status}`);
  return { requestId:data.requestId, status:data.status, paymentStatus:data.paymentStatus, data };
}

// ─── MAIN ───
async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🤖 BUYER AGENT v4 — Hybrid VPS+SCZ                     ║
║                                                          ║
║  Text/Image → uses OUR VPS dashboard direct (FREE)       ║
║  Audit/Hire → uses SCZ paid agents (gas fees apply)      ║
║                                                          ║
║  Examples:                                               ║
║    "article on PH crypto + create an image for it"       ║
║      → VPS generates document.md + image.jpg (free)      ║
║                                                          ║
║    "audit this smart contract..."                         ║
║      → SCZ hires Code Audit Agent ($1.00 + gas)          ║
╚═══════════════════════════════════════════════════════════╝
`);

  const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
  const q = (q) => new Promise(r => rl.question(q, r));

  let pk = process.env.BUYER_PK || '';
  if (!pk) { pk = (await q('🔐 Private key (0x...): ')).trim(); if (!pk.startsWith('0x')) pk='0x'+pk; }

  const provider = mkP(BASE_RPC);
  let wallet;
  try { wallet = new ethers.Wallet(pk, provider); } catch(e) { console.log('❌ Invalid key'); process.exit(1); }
  console.log(`👤 ${wallet.address}`);

  const usdc = new ethers.Contract(USDC_ADDR, [
    'function balanceOf(address) view returns (uint256)',
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external',
  ], provider);
  let bal, eth;
  try { bal=await usdc.balanceOf(wallet.address); eth=await provider.getBalance(wallet.address); } catch(e) { console.log('❌ RPC'); process.exit(1); }
  console.log(`💰 USDC: $${fU(bal,6)} | ETH: ${fE(eth).substring(0,8)}`);
  if (bal.isZero() && !process.env.BUYER_PK) { console.log('❌ No USDC'); process.exit(1); }

  const outDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n┌──────────────────────────────────────────────────────────────────┐');
  console.log('│ Type a task, or: quit | balance                                  │');
  console.log('│                                                                  │');
  console.log('│  Text+Image tasks → VPS (free, multi-file)                       │');
  console.log('│  Audit/hire tasks  → SCZ (paid)                                  │');
  console.log('└──────────────────────────────────────────────────────────────────┘\n');

  let running = true;
  while (running) {
    const input = (await q('> ')).trim();
    const cmd = input.toLowerCase();
    if (!input) continue;
    if (/^(quit|exit|q)$/.test(cmd)) { console.log('👋 Bye!'); running=false; break; }
    if (cmd==='balance') { console.log(`💰 $${fU(await usdc.balanceOf(wallet.address),6)}`); continue; }

    const type = analyze(input);
    const jobDir = path.join(outDir, `${Date.now().toString(36)}_task`);
    fs.mkdirSync(jobDir, { recursive: true });

    if (type.needsAudit) {
      // SCZ paid hire for audits
      console.log(`\n🔒 SCZ hire: Code Audit Agent ($1.00 + gas)`);
      try {
        const result = await hireSCZ(AGENTS[2], input, wallet, usdc);
        console.log(`   ${result.status} | Payment: ${result.paymentStatus}`);
        bal = await usdc.balanceOf(wallet.address);
        console.log(`   💰 $${fU(bal,6)}`);

        // Try downloading any deliverables
        const dels = result.data?.verified_output?.deliverables || [];
        if (dels.length > 0) {
          for (const d of dels) {
            if (d.uri) {
              try {
                const buf = await downloadUrl(d.uri);
                const dp = path.join(jobDir, d.name);
                fs.writeFileSync(dp, buf);
                console.log(`   ✅ ${d.name} (${(buf.length/1024).toFixed(1)} KB)`);
              } catch(e) { console.log(`   ⚠️ ${d.name}: ${e.message}`); }
            }
          }
        }
      } catch(e) { console.log(`   ❌ ${e.message}`); }
    } else {
      // VPS direct — FREE, fast, multi-file
      console.log(`\n🆓 VPS: generating content directly...`);
      try {
        const result = await generateOnVPS(input, jobDir);
        if (result.files.length > 0) {
          console.log(`\n✅ Done — ${result.files.length} file(s) in ${jobDir}`);
          for (const f of result.files) {
            const ext = path.extname(f.name).toLowerCase();
            const icon = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext) ? '🖼️' :
                         ['.md','.txt'].includes(ext) ? '📄' : '📎';
            const sz = f.size>1024 ? `${(f.size/1024).toFixed(1)} KB` : `${f.size} B`;
            console.log(`   ${icon} ${f.name} (${sz})`);
          }
        } else {
          console.log('   ⚠️ No files returned');
        }
      } catch(e) { console.log(`   ❌ ${e.message}`); }
    }
    console.log();
  }
  rl.close();
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
