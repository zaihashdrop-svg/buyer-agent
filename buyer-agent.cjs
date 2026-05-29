#!/usr/bin/env node
/**
 * BUYER AGENT — SantaClawz cross-platform buyer terminal
 * Usage: node buyer-agent.cjs
 * Runs on: Windows CMD, PowerShell, Linux/macOS terminal
 *
 * No dependencies to install manually — auto-installs ethers.js on first run.
 */

// ─── Auto-install ethers if missing ───
try {
  require('ethers');
} catch(e) {
  const { execSync } = require('child_process');
  console.log('📦 Installing ethers.js (one-time)...');
  execSync('npm install ethers@5.7', { stdio: 'inherit', cwd: __dirname });
}

const ethers = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const http = require('http');
const https = require('https');

// ─── ethers version compat ───
const E6 = ethers.version && ethers.version.startsWith('6');
const signTypedData = (wallet, domain, types, msg) =>
  E6 ? wallet.signTypedData(domain, types, msg) : wallet._signTypedData(domain, types, msg);
const parseSignature = (sig) =>
  E6 ? ethers.Signature.from(sig) : ethers.utils.splitSignature(sig);
const formatUnits = (val, dec) =>
  E6 ? ethers.formatUnits(val, dec) : ethers.utils.formatUnits(val, dec);
const formatEther = (val) =>
  E6 ? ethers.formatEther(val) : ethers.utils.formatEther(val);
const makeProvider = (url) =>
  E6 ? new ethers.JsonRpcProvider(url) : new ethers.providers.JsonRpcProvider(url);

// ─── Stable JSON (exact match for @clawz/protocol) ───
function normalizeValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeValue(item));
    }
    if (value && typeof value === "object") {
        const sortedEntries = Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalizeValue(nested)]);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}
function stableStringify(value) {
    return JSON.stringify(normalizeValue(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// ─── Download helper for artifact files ───
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

function canonicalDigest(value) {
  return { sha256Hex: sha256Hex(stableStringify(value)) };
}

function jsonSafe(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(jsonSafe);
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) r[k] = jsonSafe(v);
    return r;
  }
  return obj;
}

const API_BASE = 'https://api.santaclawz.ai';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ─── Agent matching rules ───
const AGENT_RULES = [
  { keywords: ['image', 'picture', 'generate', 'visual', 'photo', 'draw', 'create.*png',
               'create.*jpg', 'illustration', 'artwork', 'graphic', 'design', 'poster',
               'banner', 'logo', 'meme', 'art', 'painting', 'render', 'cartoon'],
    agentName: 'Zaitek Technologies', id: 'zaitek-technologies--session_agent_b4a646d96b37', price: '$1.00' },
  { keywords: ['audit', 'security', 'vulnerability', 'reentrancy', 'smart contract',
               'solidity', 'exploit', 'hack', 'bug', 'overflow', 'injection'],
    agentName: 'Code Audit Agent', id: 'code-audit-agent--session_agent_51a8f5e04659', price: '$1.00' },
  { keywords: ['job pack', 'content idea', 'bundle', 'digital product', 'pack'],
    agentName: 'Agent Job Pack', id: 'agent-job-pack--session_agent_481978b8e6ea', price: '$0.25' },
  { keywords: ['windows', 'document', 'spreadsheet', 'excel', 'word', 'powerpoint'],
    agentName: 'Zaitek Technologies (Windows)', id: 'zaitek-technologies-windows--session_agent_788cc04c082a', price: '$0.25' },
];

const DEFAULT_AGENT = {
  agentName: 'zaiclaw', id: 'zaiclaw--session_agent_1ef352f6cda1', price: '$0.25'
};

function matchAgent(task) {
  const t = task.toLowerCase();
  for (const rule of AGENT_RULES) {
    for (const kw of rule.keywords) {
      try {
        if (new RegExp('\\b' + kw.replace(/\.\*/g, '.*') + '\\b', 'i').test(t)) return rule;
      } catch(e) {
        if (t.includes(kw)) return rule;
      }
    }
  }
  return DEFAULT_AGENT;
}

// ─── Simple fetch polyfill (no external deps) ───
function simpleFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    const urlObj = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, options.headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch(e) { data = raw; }
        resolve({ status: res.statusCode, json: async () => data, text: async () => raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── x402 Hire Engine ───
async function hireAgent(agent, task, wallet) {
  const preflightRes = await simpleFetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method: 'POST',
    body: JSON.stringify({ taskPrompt: task, requesterContact: `buyer:${wallet.address}` })
  });
  const hireResp = await preflightRes.json();
  const accept = hireResp.accepts?.[0];
  if (!accept) {
    const errMsg = hireResp.error || hireResp.code || 'no accept available';
    if (hireResp.retryable) throw new Error(`Agent offline (${errMsg}) — try again later`);
    throw new Error(errMsg);
  }

  const fees = accept.extensions?.evm?.feeSplit;
  const requestId = hireResp.requestId;
  const sellerAmount = BigInt(fees.sellerAmount);
  const protocolAmount = BigInt(fees.protocolFeeAmount);
  const sellerPayTo = fees.sellerPayTo;
  const protocolPayTo = fees.protocolFeePayTo;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_ADDRESS };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const sellerNonce = '0x' + crypto.randomBytes(32).toString('hex');
  const sellerMsg = { from: wallet.address, to: sellerPayTo, value: sellerAmount, validAfter: 0n, validBefore, nonce: sellerNonce };
  const sellerSig = await signTypedData(wallet, domain, types, sellerMsg);
  const sellerParsed = parseSignature(sellerSig);

  const protocolNonce = '0x' + crypto.randomBytes(32).toString('hex');
  const protocolMsg = { from: wallet.address, to: protocolPayTo, value: protocolAmount, validAfter: 0n, validBefore, nonce: protocolNonce };
  const protocolSig = await signTypedData(wallet, domain, types, protocolMsg);
  const protocolParsed = parseSignature(protocolSig);

  const amount = accept.price;
  const paymentId = 'pay_' + crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const payload = {
    protocol: 'x402', networkId: 'eip155:8453', settlementRail: 'evm',
    requestId, payTo: accept.payTo, paymentId,
    issuedAtIso: now.toISOString(),
    expiresAtIso: new Date(now.getTime() + 3600000).toISOString(),
    amount, asset: accept.asset, scheme: 'exact',
    extensions: { evm: { amountUnit: 'atomic' } },
    authorization: { typedData: { domain, types, message: sellerMsg }, signature: sellerSig },
    accepted: {
      network: 'eip155:8453', payTo: accept.payTo, asset: USDC_ADDRESS, amount,
      extra: { feeSplit: { grossAmount: amount, sellerAmount: fees.sellerAmount, protocolFeeAmount: fees.protocolFeeAmount, protocolFeePayTo: fees.protocolFeePayTo, protocolFeePayToLabel: 'SantaClawz Protocol Fee', protocolFeeRecipient: fees.protocolFeePayTo, sellerPayTo: fees.sellerPayTo, feeSettlementMode: 'exact-eip3009-split-v1', version: 'protocol-owner-fee-v1', feeBps: fees.feeBps } },
    },
    payload: {
      signature: sellerSig,
      authorization: { from: wallet.address, to: sellerPayTo, value: sellerAmount.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce: sellerNonce, v: '0x' + sellerParsed.v.toString(16), r: sellerParsed.r, s: sellerParsed.s },
      feeAuthorization: { signature: protocolSig, authorization: { from: wallet.address, to: protocolPayTo, value: protocolAmount.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce: protocolNonce, v: '0x' + protocolParsed.v.toString(16), r: protocolParsed.r, s: protocolParsed.s } },
    },
    feeAuthorization: { typedData: { domain, types, message: protocolMsg }, signature: protocolSig },
    resource: { url: hireResp.resource, description: 'SantaClawz agent hire', mimeType: 'application/json' },
  };

  const { sha256Hex: authDigest } = canonicalDigest(jsonSafe(payload));
  payload.authorizationDigest = authDigest;

  // On-chain protocol fee
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external',
    'function balanceOf(address) view returns (uint256)',
  ], wallet);

  try {
    const tx = await usdc.transferWithAuthorization(
      wallet.address, protocolPayTo, protocolAmount, 0n, validBefore,
      protocolNonce, protocolParsed.v, protocolParsed.r, protocolParsed.s
    );
    await tx.wait();
  } catch(e) {
    // Non-critical
  }

  // Submit
  const body = {
    taskPrompt: task, requesterContact: `buyer:${wallet.address}`,
    paymentPayload: payload,
  };
  const res = await simpleFetch(`${API_BASE}/api/agents/${agent.id}/hire`, {
    method: 'POST',
    body: JSON.stringify(jsonSafe(body)),
  });
  const data = await res.json();

  if (res.status >= 400) throw new Error(data.error || `HTTP ${res.status}`);

  return {
    requestId: data.requestId,
    status: data.status,
    paymentStatus: data.paymentStatus,
    responseBody: data.localResponseBody,
    relayTrace: data.relayTrace,
  };
}

// ─── Main ───
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise(r => rl.question(q, r));

  console.log(`
╔══════════════════════════════════════════╗
║         🤖  BUYER AGENT  v1.0           ║
║     SantaClawz Cross-Platform Buyer      ║
╚══════════════════════════════════════════╝`);

  // Step 1: Private key
  let pk = process.env.BUYER_PK || '';
  if (!pk) {
    pk = (await question('🔐 Enter wallet private key (0x...): ')).trim();
    if (pk && !pk.startsWith('0x')) pk = '0x' + pk;
  }

  if (!pk) {
    console.log('❌ No private key provided. Set BUYER_PK env var or enter it.');
    process.exit(1);
  }

  // Step 2: Connect
  const provider = makeProvider(BASE_RPC);
  let wallet;
  try {
    wallet = new ethers.Wallet(pk, provider);
  } catch(e) {
    console.log('❌ Invalid private key');
    process.exit(1);
  }
  console.log(`👤 Wallet: ${wallet.address}`);

  // Step 3: Check balance
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function balanceOf(address) view returns (uint256)',
  ], provider);
  let usdcBal, ethBal;
  try {
    usdcBal = await usdc.balanceOf(wallet.address);
    ethBal = await provider.getBalance(wallet.address);
  } catch(e) {
    console.log('❌ Cannot reach Base network. Check connection.');
    process.exit(1);
  }
  console.log(`💰 USDC: $${formatUnits(usdcBal, 6)}`);
  console.log(`⛽ ETH: ${Number(formatEther(ethBal)).toFixed(6)}`);

  if (usdcBal == 0 || (typeof usdcBal === 'object' && usdcBal.isZero && usdcBal.isZero())) {
    console.log('❌ No USDC. Fund your wallet on Base mainnet first.');
    process.exit(1);
  }

  // Step 4: Fetch available agents
  console.log('📡 Fetching agents...');
  let hireable = [];
  try {
    const agentRes = await simpleFetch(`${API_BASE}/api/agents`);
    const allAgents = await agentRes.json();
    hireable = allAgents.filter(a => a.readiness?.hireable && a.runtimeStatus === 'live');
    console.log(`📋 ${hireable.length} agents available:\n`);
    for (const a of hireable) {
      console.log(`   ${a.agentName.padEnd(36)} $${(a.fixedAmountUsd || '?').padEnd(5)}`);
    }
    console.log('');
  } catch(e) {
    console.log('⚠️  Could not fetch agents list (API may be down). Will use default matching.');
  }

  // Step 5: Output directory
  const outputDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('┌─ Chat mode ────────────────────────────────────────────────┐');
  console.log('│ Type a task, or: quit | balance | agents | help            │');
  console.log('└────────────────────────────────────────────────────────────┘\n');

  let running = true;
  while (running) {
    const input = (await question('> ')).trim();
    const cmd = input.toLowerCase();

    if (!input) continue;
    if (['quit', 'exit', 'q'].includes(cmd)) {
      console.log('👋 Bye!');
      running = false;
      break;
    }
    if (cmd === 'balance') {
      const b = await usdc.balanceOf(wallet.address);
      console.log(`💰 USDC: $${formatUnits(b, 6)}`);
      continue;
    }
    if (cmd === 'agents') {
      for (const a of hireable) {
        console.log(`   ${a.agentName.padEnd(36)} $${(a.fixedAmountUsd || '?').padEnd(5)}`);
      }
      continue;
    }
    if (cmd === 'help') {
      console.log('Commands: quit, balance, agents');
      console.log('Or type any task and the buyer agent picks the best AI agent for it.');
      console.log('Examples:');
      console.log('  "generate a futuristic city image" → Zaitek Tech ($1.00)');
      console.log('  "audit this Solidity contract"     → Code Audit ($1.00)');
      console.log('  "write a poem about AI"             → zaiclaw ($0.25)');
      console.log('  "research web3 market trends"       → zaiclaw ($0.25)');
      continue;
    }

    // Match agent
    const agent = matchAgent(input);
    const usdcNum = parseFloat(formatUnits(usdcBal, 6));
    const agentPrice = parseFloat(agent.price.replace('$', ''));
    if (usdcNum < agentPrice) {
      console.log(`❌ Insufficient balance ($${usdcNum.toFixed(2)}) for ${agent.agentName} (${agent.price})`);
      continue;
    }

    console.log(`🤖 → ${agent.agentName} (${agent.price})`);

    const spinner = ['|', '/', '-', '\\'];
    let spi = 0;
    const spin = setInterval(() => { process.stdout.write('\r⏳ Processing... ' + spinner[spi % 4]); spi++; }, 200);

    try {
      const result = await hireAgent(agent, input, wallet);
      clearInterval(spin);

      if (result.paymentStatus === 'settled' || result.status === 'completed') {
        process.stdout.write('\r✅ Done!                          \n');
        usdcBal = await usdc.balanceOf(wallet.address);
        console.log(`💰 Balance: $${formatUnits(usdcBal, 6)}`);

        // Save output
        const slug = input.replace(/[^a-z0-9]/gi, '_').substring(0, 40).toLowerCase();
        const timestamp = Date.now().toString(36);
        const safeName = `${timestamp}_${slug}`;

        // Try to download the actual artifact from the SCZ result
        let savedFile = null;
        if (result.responseBody) {
          // Check if it's an image (base64 or URL)
          const bodyStr = typeof result.responseBody === 'string' ? result.responseBody : JSON.stringify(result.responseBody);
          const b64Match = bodyStr.match(/data:image\/(jpeg|png|webp);base64,([a-zA-Z0-9+/=]+)/);
          if (b64Match) {
            const ext = b64Match[1] === 'jpeg' ? 'jpg' : b64Match[1];
            const imgData = Buffer.from(b64Match[2], 'base64');
            const filePath = path.join(outputDir, `${safeName}.${ext}`);
            fs.writeFileSync(filePath, imgData);
            savedFile = filePath;
            console.log(`🖼️ ${filePath} (${(imgData.length / 1024).toFixed(0)}KB)`);
          } else if (bodyStr.match(/https?:\/\/.+\.(jpeg|jpg|png|gif|webp)/i)) {
            const url = bodyStr.match(/https?:\/\/[^\s"']+\.(jpeg|jpg|png|gif|webp)/i)[0];
            const ext = url.match(/\.(jpeg|jpg|png|gif|webp)/i)[1].replace('jpeg','jpg');
            const filePath = path.join(outputDir, `${safeName}.${ext}`);
            try { await downloadFile(url, filePath); savedFile = filePath; console.log(`🖼️ ${filePath}`); }
            catch(e) { /* fall through to json */ }
          }
        }

        if (!savedFile) {
          // Save summary JSON
          const summary = JSON.stringify({
            agent: agent.agentName, task: input, requestId: result.requestId,
            status: result.status, paymentStatus: result.paymentStatus,
            completedAt: new Date().toISOString(),
            relayTrace: result.relayTrace,
          }, null, 2);
          const filePath = path.join(outputDir, `${safeName}.json`);
          fs.writeFileSync(filePath, summary);
          console.log(`📄 ${filePath}`);
        }

        // Show relay trace
        if (result.relayTrace) {
          const steps = result.relayTrace.filter(s => s.status === 'completed' || s.status === 'failed');
          for (const s of steps.slice(0, 4)) {
            const mark = s.status === 'completed' ? '✅' : '❌';
            console.log(`   ${mark} ${s.step}`);
          }
        }
      } else {
        process.stdout.write('\r');
        console.log(`⚠️  ${result.status} — payment: ${result.paymentStatus}`);
      }
    } catch(e) {
      clearInterval(spin);
      process.stdout.write('\r');
      console.log(`❌ ${e.message}`);
    }
  }

  rl.close();
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
