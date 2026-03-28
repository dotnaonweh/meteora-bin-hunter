const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const BN = require('bn.js');
const bs58 = require('bs58');
const https = require('https');
const fs = require('fs');

const StrategyType = { Spot: 0, Curve: 1, BidAsk: 2 };
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MONITOR_INTERVAL = 2500;

const RPC_LIST = [
  { label: 'Helius', url: 'https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY' },
  { label: 'Solana Public', url: 'https://api.mainnet-beta.solana.com' },
  { label: 'Helius Pump', url: 'https://pump.helius-rpc.com/' },
];

const DATA_FILE = './data.json';

function loadEnvFile() {
  try {
    const envFile = fs.readFileSync('./.env', 'utf8');
    envFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key) process.env[key] = val;
    });
  } catch { }
}
loadEnvFile();

// Replace Helius RPC URL with actual API key from env
if (process.env.HELIUS_API_KEY) {
  RPC_LIST[0].url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

function loadData() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { data = { wallets: {}, activeWalletId: null, positions: {}, presets: {}, activePresetId: null }; }
  if (!data.presets) data.presets = {};
  return data;
}
function saveData() {
  // Sanitize before writing — make sure no PK sneaks into wallet name
  const safe = JSON.parse(JSON.stringify(state));
  for (const w of Object.values(safe.wallets || {})) {
    if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(w.name)) {
      w.name = 'Wallet';
    }
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2));
}
const state = loadData();

const extremeSessions = {};

function saveEnvFile() {
  try {
    let existing = '';
    try { existing = fs.readFileSync('./.env', 'utf8'); } catch { }
    const lines = existing.split('\n').filter(l => {
      const key = l.split('=')[0].trim();
      return key && !/^WALLET_\d+$/.test(key);
    });
    const walletLines = Object.entries(process.env)
      .filter(([k]) => /^WALLET_\d+$/.test(k))
      .map(([k, v]) => `${k}=${v}`);
    const allLines = [...lines.filter(Boolean), ...walletLines];
    fs.writeFileSync('./.env', allLines.join('\n') + '\n');
    fs.chmodSync('./.env', 0o600);
  } catch (e) { console.error('[Env] saveEnvFile error:', e.message); }
}

function getNextWalletEnvKey() {
  let i = 1;
  while (process.env[`WALLET_${i}`]) i++;
  return `WALLET_${i}`;
}

function getActiveWallet() {
  if (!state.activeWalletId || !state.wallets[state.activeWalletId]) return null;
  const envKey = state.wallets[state.activeWalletId].envKey;
  const pk = envKey ? process.env[envKey] : null;
  if (!pk) throw new Error(`PK tidak ditemukan. Isi ${envKey} di .env`);
  return Keypair.fromSecretKey(bs58.default.decode(pk));
}
function addWallet(name, pk) {
  const kp = Keypair.fromSecretKey(bs58.default.decode(pk));
  const id = kp.publicKey.toBase58().slice(0, 8);
  const envKey = getNextWalletEnvKey();
  process.env[envKey] = pk;
  saveEnvFile();
  state.wallets[id] = { id, name, pubkey: kp.publicKey.toBase58(), envKey };
  if (!state.activeWalletId) state.activeWalletId = id;
  saveData();
  return { id, pubkey: kp.publicKey.toBase58(), envKey };
}
function switchWallet(id) {
  if (!state.wallets[id]) throw new Error('Wallet tidak ditemukan');
  state.activeWalletId = id;
  saveData();
}
function deleteWallet(id) {
  if (!state.wallets[id]) throw new Error('Wallet tidak ditemukan');
  const envKey = state.wallets[id].envKey;
  delete process.env[envKey];
  delete state.wallets[id];
  if (state.activeWalletId === id) {
    state.activeWalletId = Object.keys(state.wallets)[0] || null;
  }
  saveEnvFile();
  saveData();
}
function getActivePreset() {
  if (!state.presets) state.presets = {};
  return (state.activePresetId && state.presets[state.activePresetId])
    || Object.values(state.presets)[0]
    || null;
}
function addPreset(id, name, sol, range, strategy) {
  if (!state.presets) state.presets = {};
  state.presets[id] = { name, sol, range, strategy };
  saveData();
}
function switchPreset(id) {
  if (!state.presets[id]) throw new Error('Preset tidak ditemukan');
  state.activePresetId = id;
  saveData();
}
function deletePreset(id) {
  delete state.presets[id];
  if (state.activePresetId === id) state.activePresetId = Object.keys(state.presets)[0] || null;
  saveData();
}

let connection;
async function pingRpc(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    new Connection(url, 'confirmed').getSlot()
      .then(() => resolve({ url, ms: Date.now() - start }))
      .catch(() => resolve({ url, ms: 99999 }));
  });
}
async function getBestRpc() {
  const results = await Promise.all(RPC_LIST.map(r => pingRpc(r.url)));
  results.sort((a, b) => a.ms - b.ms);
  results.forEach(r => console.log(`[RPC] ${RPC_LIST.find(x => x.url === r.url)?.label}: ${r.ms}ms`));
  return results[0].url;
}

function extractPoolAddress(input) {
  const match = input.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/g);
  return match ? match[match.length - 1] : null;
}
function solToLamports(sol) { return new BN(Math.floor(sol * LAMPORTS_PER_SOL)); }
async function resolveSolAmount(solInput, walletPubkey) {
  if (solInput === 'max') {
    const bal = await getSolBalance(walletPubkey);
    return parseFloat((Math.max(0, bal - 0.08)).toFixed(4));
  }
  if (typeof solInput === 'string' && solInput.endsWith('%')) {
    const pct = parseFloat(solInput);
    if (isNaN(pct) || pct <= 0 || pct > 100) throw new Error('Persenan harus antara 1-100%');
    const bal = await getSolBalance(walletPubkey);
    const usable = Math.max(0, bal - 0.08);
    return parseFloat((usable * pct / 100).toFixed(4));
  }
  return parseFloat(solInput);
}
async function getSolBalance(pubkey) { return (await connection.getBalance(new PublicKey(pubkey))) / LAMPORTS_PER_SOL; }
function rangeToBins(rangePercent, binStep) { return Math.ceil((rangePercent / 100) / (binStep / 10000)); }
function parseStrategy(str) {
  const s = (str || 'spot').toLowerCase();
  if (s === 'curve') return StrategyType.Curve;
  if (s === 'bidask' || s === 'bid-ask') return StrategyType.BidAsk;
  return StrategyType.Spot;
}
function isPoolInput(text) {
  return (text.includes('meteora.ag/dlmm/') || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) && !text.startsWith('/');
}
function shortKey(key) { return key.slice(0, 6) + '...' + key.slice(-4); }
function solLabel(sol) { return sol === 'max' ? 'MAX SOL' : (typeof sol === 'string' && sol.endsWith('%')) ? `${sol} balance` : `${sol} SOL`; }

async function getPoolAndActiveBin(poolAddress) {
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  const activeBin = await dlmmPool.getActiveBin();
  return { dlmmPool, activeBin };
}

async function openExtremePosition(poolAddress, solAmount) {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const finalSol = await resolveSolAmount(solAmount, wallet.publicKey.toBase58());
  if (!finalSol || finalSol < 0.001) throw new Error(`SOL tidak cukup (${finalSol} SOL). Minimal 0.001 SOL + 0.08 untuk fee.`);
  const { dlmmPool, activeBin } = await getPoolAndActiveBin(poolAddress);
  await dlmmPool.refetchStates();
  const targetBinId = activeBin.binId;
  const newPosition = Keypair.generate();
  const createTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(0),
    totalYAmount: solToLamports(finalSol),
    strategy: { minBinId: targetBinId, maxBinId: targetBinId, strategyType: StrategyType.BidAsk },
  });
  const txHash = await sendAndConfirmTransaction(connection, createTx, [wallet, newPosition]);
  return { positionKey: newPosition.publicKey.toBase58(), targetBinId, txHash, solUsed: finalSol };
}

async function withdrawAndReaddToTargetBin(poolAddress, positionKey, targetBinId) {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates();
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const userPos = userPositions.find(p => p.publicKey.toBase58() === positionKey);
  if (!userPos) throw new Error('Position tidak ditemukan');
  const binData = userPos.positionData.positionBinData;
  if (!binData || binData.length === 0) return null;
  const tokenXMint = dlmmPool.lbPair.tokenXMint.toBase58();
  const tokenYMint = dlmmPool.lbPair.tokenYMint.toBase58();
  const isTokenX = tokenXMint !== SOL_MINT;
  const tokenMint = isTokenX ? tokenXMint : tokenYMint;
  const binIds = binData.map(b => b.binId);
  const removeTx = await dlmmPool.removeLiquidity({
    position: new PublicKey(positionKey),
    user: wallet.publicKey,
    fromBinId: binIds[0],
    toBinId: binIds[binIds.length - 1],
    bps: new BN(10000),
    shouldClaimAndClose: false,
  });
  const txList = Array.isArray(removeTx) ? removeTx : [removeTx];
  await Promise.all(txList.map(tx =>
    sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'processed' })
  ));
  let tokenBalance = new BN(0);
  const _deadline = Date.now() + 10000;
  while (Date.now() < _deadline) {
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey, { mint: new PublicKey(tokenMint) }, 'processed'
      );
      if (tokenAccounts.value.length > 0) {
        const amt = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
        tokenBalance = new BN(amt);
        if (tokenBalance.gtn(0)) break;
      }
    } catch (e) { }
    await new Promise(r => setTimeout(r, 500));
  }
  if (tokenBalance.eqn(0)) { console.log('[Extreme] No token balance after withdraw, skipping readd'); return 'no_token'; }
  await dlmmPool.refetchStates();
  const addTx = await dlmmPool.addLiquidityByStrategy({
    positionPubKey: new PublicKey(positionKey),
    user: wallet.publicKey,
    totalXAmount: isTokenX ? tokenBalance : new BN(0),
    totalYAmount: isTokenX ? new BN(0) : tokenBalance,
    strategy: { minBinId: targetBinId, maxBinId: targetBinId, strategyType: StrategyType.BidAsk },
  });
  const addHash = await sendAndConfirmTransaction(connection, addTx, [wallet], { skipPreflight: true, commitment: 'processed' });
  return addHash;
}

async function closeAndReopenPosition(poolAddress, positionKey, solAmount) {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates();
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const userPos = userPositions.find(p => p.publicKey.toBase58() === positionKey);
  if (userPos) {
    const binIds = userPos.positionData.positionBinData.map(b => b.binId);
    if (binIds.length > 0) {
      const removeTx = await dlmmPool.removeLiquidity({
        position: new PublicKey(positionKey), user: wallet.publicKey,
        fromBinId: binIds[0], toBinId: binIds[binIds.length - 1],
        bps: new BN(10000), shouldClaimAndClose: true,
      });
      const txList = Array.isArray(removeTx) ? removeTx : [removeTx];
      await Promise.all(txList.map(tx =>
        sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'processed' })
      ));
    }
  }
  return await openExtremePosition(poolAddress, solAmount);
}

async function closeExtremePositionOnly(poolAddress, positionKey) {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates();
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const userPos = userPositions.find(p => p.publicKey.toBase58() === positionKey);
  if (!userPos) return [];
  const binIds = userPos.positionData.positionBinData.map(b => b.binId);
  if (binIds.length > 0) {
    const removeTx = await dlmmPool.removeLiquidity({
      position: new PublicKey(positionKey), user: wallet.publicKey,
      fromBinId: binIds[0], toBinId: binIds[binIds.length - 1],
      bps: new BN(10000), shouldClaimAndClose: true,
    });
    const txList = Array.isArray(removeTx) ? removeTx : [removeTx];
    return await Promise.all(txList.map(tx =>
      sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'processed' })
    ));
  } else {
    try {
      const closeTx = await dlmmPool.closePosition({ owner: wallet.publicKey, position: userPos });
      const hash = await sendAndConfirmTransaction(connection, closeTx, [wallet], { skipPreflight: true, commitment: 'processed' });
      return [hash];
    } catch(e) { return []; }
  }
}

async function extremeMonitorTick(chatId) {
  const session = extremeSessions[chatId];
  if (!session || session.status === 'stopped') return;
  try {
    const { dlmmPool, activeBin } = await getPoolAndActiveBin(session.poolAddress);
    const currentBinId = activeBin.binId;
    if (session.status === 'active') {
      if (currentBinId > session.targetBinId) {
        session.cycleCount = (session.cycleCount || 0) + 1;
        session.status = 'executing';
        await tgSend(chatId, '➡️ OOR kanan! Bin: ' + currentBinId + ' > ' + session.targetBinId + ' (Cycle #' + session.cycleCount + ') - Closing...');
        await closeExtremePositionOnly(session.poolAddress, session.positionKey);
        await new Promise(r => setTimeout(r, 3000));
        const walletR = getActiveWallet();
        const solR = await resolveSolAmount(session.solAmount, walletR.publicKey.toBase58());
        if (solR < 0.01) { session.status = 'stopped'; await tgSend(chatId, '⚠️ SOL habis. Extreme mode dihentikan.'); return; }
        const resultR = await openExtremePosition(session.poolAddress, solR);
        session.positionKey = resultR.positionKey;
        session.targetBinId = resultR.targetBinId;
        session.status = 'active';
        await tgSend(chatId, '✅ Cycle #' + session.cycleCount + ' (kanan) SOL: ' + solR + ' New bin: ' + resultR.targetBinId,
          { inline_keyboard: [[{ text: '🛑 Stop Extreme', callback_data: 'extreme:stop:' + chatId }]] });
      } else if (currentBinId < session.targetBinId) {
        session.status = 'oor';
        await tgSend(chatId, `⚠️ EXTREME: Out of Range!\n🎯 Target bin: ${session.targetBinId}\n📍 Current bin: ${currentBinId}\n\n⏳ Withdraw & readd token ke bin ${session.targetBinId}...`);
        let txHash;
        try {
          txHash = await withdrawAndReaddToTargetBin(session.poolAddress, session.positionKey, session.targetBinId);
        } catch (oorErr) {
          session.status = 'waiting';
          await tgSend(chatId, `⚠️ Withdraw/readd error: ${oorErr.message}\n👀 Menunggu harga balik ke bin ${session.targetBinId}...`);
          return;
        }
        if (txHash === 'no_token') {
          session.status = 'waiting';
          await tgSend(chatId, `⚠️ Ga ada token setelah withdraw. Menunggu harga balik...`);
        } else {
          session.status = 'waiting';
          await tgSend(chatId, `✅ Token di-add balik ke bin ${session.targetBinId}\n🔗 Tx: ${txHash}\n\n👀 Menunggu harga naik ke bin ${session.targetBinId}...`);
        }
      }
    } else if (session.status === 'executing') {
      // skip
    } else if (session.status === 'waiting') {
      if (currentBinId >= session.targetBinId) {
        session.cycleCount = (session.cycleCount || 0) + 1;
        session.status = 'executing';
        await tgSend(chatId, '🎯 Harga balik! Cycle #' + session.cycleCount + ' - Closing posisi...');
        await closeExtremePositionOnly(session.poolAddress, session.positionKey);
        await new Promise(r => setTimeout(r, 3000));
        const wallet2 = getActiveWallet();
        const solToUse = await resolveSolAmount(session.solAmount, wallet2.publicKey.toBase58());
        if (solToUse < 0.01) { session.status = 'stopped'; await tgSend(chatId, '⚠️ SOL habis (' + solToUse.toFixed(4) + ' SOL). Extreme mode dihentikan.'); return; }
        const result2 = await openExtremePosition(session.poolAddress, solToUse);
        session.positionKey = result2.positionKey;
        session.targetBinId = result2.targetBinId;
        session.status = 'active';
        await tgSend(chatId, '✅ Cycle #' + session.cycleCount + ' selesai! SOL: ' + solToUse + ' New bin: ' + result2.targetBinId + ' Tx: ' + result2.txHash,
          { inline_keyboard: [[{ text: '🛑 Stop Extreme', callback_data: 'extreme:stop:' + chatId }]] });
      }
    }
  } catch (e) {
    console.error('[Extreme] Monitor error:', e.message);
    await tgSend(chatId, `⚠️ Extreme monitor error: ${e.message}`).catch(() => {});
  }
  if (extremeSessions[chatId]?.status !== 'stopped') {
    extremeSessions[chatId].timer = setTimeout(() => extremeMonitorTick(chatId), MONITOR_INTERVAL);
  }
}

function stopExtremeSession(chatId) {
  const session = extremeSessions[chatId];
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.status = 'stopped';
}

async function addLiquidity(poolAddress, solAmount, rangePercent, strategyStr) {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif. Import wallet dulu!');
  const finalSol = await resolveSolAmount(solAmount, wallet.publicKey.toBase58());
  if (!finalSol || finalSol < 0.001) throw new Error(`SOL tidak cukup (${finalSol} SOL). Minimal 0.001 SOL + 0.08 untuk fee.`);
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates();
  const activeBin = await dlmmPool.getActiveBin();
  const totalBins = rangeToBins(rangePercent, dlmmPool.lbPair.binStep);
  const minBinId = activeBin.binId - totalBins;
  const maxBinId = activeBin.binId;
  const newPosition = Keypair.generate();
  const createTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey, user: wallet.publicKey,
    totalXAmount: new BN(0), totalYAmount: solToLamports(finalSol),
    strategy: { maxBinId, minBinId, strategyType: parseStrategy(strategyStr) },
  });
  const txHash = await sendAndConfirmTransaction(connection, createTx, [wallet, newPosition]);
  const cachedBinIds = [];
  for (let i = minBinId; i <= maxBinId; i++) cachedBinIds.push(i);
  state.positions[newPosition.publicKey.toBase58()] = {
    poolAddress, minBinId, maxBinId, activeBinAtAdd: activeBin.binId,
    solAmount: finalSol, rangePercent, strategyStr,
    addedAt: new Date().toISOString(), txHash, cachedBinIds,
    walletId: state.activeWalletId,
  };
  saveData();
  return { positionKey: newPosition.publicKey.toBase58(), txHash, minBinId, maxBinId, activeBin: activeBin.binId, solUsed: finalSol };
}

async function removeLiquidity(positionKey) {
  const posData = state.positions[positionKey];
  if (!posData) throw new Error('Position tidak ditemukan');
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const dlmmPool = await DLMM.create(connection, new PublicKey(posData.poolAddress));
  const binIds = posData.cachedBinIds && posData.cachedBinIds.length
    ? posData.cachedBinIds
    : (() => { const b = []; for (let i = posData.minBinId; i <= posData.maxBinId; i++) b.push(i); return b; })();
  const removeTx = await dlmmPool.removeLiquidity({
    position: new PublicKey(positionKey), user: wallet.publicKey,
    fromBinId: binIds[0], toBinId: binIds[binIds.length - 1],
    bps: new BN(10000), shouldClaimAndClose: true,
  });
  const txList = Array.isArray(removeTx) ? removeTx : [removeTx];
  const txHashes = await Promise.all(txList.map(tx =>
    sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'processed' })
  ));
  delete state.positions[positionKey];
  saveData();
  return txHashes;
}

async function getPositionStatus(positionKey) {
  const posData = state.positions[positionKey];
  if (!posData) return null;
  const dlmmPool = await DLMM.create(connection, new PublicKey(posData.poolAddress));
  const activeBin = await dlmmPool.getActiveBin();
  return { ...posData, currentBin: activeBin.binId, inRange: activeBin.binId >= posData.minBinId && activeBin.binId <= posData.maxBinId };
}

async function syncPositions() {
  const wallet = getActiveWallet();
  if (!wallet) throw new Error('Tidak ada wallet aktif');
  const allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);
  let added = 0, total = 0;
  const onChainKeys = new Set();
  for (const [poolAddress, poolData] of allPositions) {
    const positions = poolData.lbPairPositionsData || [];
    total += positions.length;
    for (const pos of positions) {
      const posKey = pos.publicKey.toBase58();
      onChainKeys.add(posKey);
      if (state.positions[posKey]) continue;
      const binData = pos.positionData?.positionBinData || [];
      const binIds = binData.map(b => b.binId);
      const totalYLamports = binData.reduce((sum, b) => sum + (Number(b.positionYAmount) || 0), 0);
      state.positions[posKey] = {
        poolAddress, minBinId: binIds.length ? Math.min(...binIds) : 0,
        maxBinId: binIds.length ? Math.max(...binIds) : 0,
        activeBinAtAdd: 0, solAmount: parseFloat((totalYLamports / 1e9).toFixed(4)),
        rangePercent: 0, strategyStr: 'synced',
        addedAt: new Date().toISOString(), txHash: 'synced',
        cachedBinIds: binIds, walletId: state.activeWalletId, synced: true,
      };
      added++;
    }
  }
  let removed = 0;
  for (const posKey of Object.keys(state.positions)) {
    if (!onChainKeys.has(posKey)) { delete state.positions[posKey]; removed++; }
  }
  saveData();
  return { total, added, removed };
}

const chatIds = new Set();
function fetchJSON(url, options) {
  return new Promise((resolve, reject) => {
    https.get(url, options || {}, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function tgRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { resolve(JSON.parse(d)); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function tgSend(chatId, text, reply_markup) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (reply_markup) payload.reply_markup = reply_markup;
  return tgRequest('sendMessage', payload);
}
function tgEdit(chatId, messageId, text, reply_markup) {
  const payload = { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true };
  if (reply_markup) payload.reply_markup = reply_markup;
  return tgRequest('editMessageText', payload);
}
function tgAnswer(callbackQueryId) {
  return tgRequest('answerCallbackQuery', { callback_query_id: callbackQueryId });
}
function tgDelete(chatId, messageId) {
  return tgRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
}

function mainMenu(wallet) {
  const walletLine = wallet
    ? `💼 ${state.wallets[state.activeWalletId]?.name || 'Wallet'}: ${shortKey(wallet.publicKey.toBase58())}`
    : '💼 Belum ada wallet';
  const preset = getActivePreset();
  const presetLine = preset
    ? `⚡ Strat: ${preset.name} (${solLabel(preset.sol)} | -${preset.range}% | ${preset.strategy})`
    : '⚡ Strat: belum ada preset';
  const activeExtreme = Object.values(extremeSessions).find(s => s.status !== 'stopped');
  return {
    text: `🌊 METEORA DLMM BOT\n━━━━━━━━━━━━━━━━━━━━\n${walletLine}\n${presetLine}\n${activeExtreme ? '🔴 EXTREME MODE AKTIF\n' : ''}━━━━━━━━━━━━━━━━━━━━\n\nPilih menu:`,
    markup: {
      inline_keyboard: [
        [{ text: '➕ Add LP', callback_data: 'menu:addlp' }, { text: '📊 Posisi', callback_data: 'menu:positions' }],
        [{ text: '💼 Wallet', callback_data: 'menu:wallet' }, { text: '🌐 RPC', callback_data: 'menu:rpc' }],
        [{ text: '⚡ Strategy', callback_data: 'menu:strat' }, { text: '💰 Balance', callback_data: 'menu:balance' }],
        [{ text: '🔄 Sync Posisi', callback_data: 'menu:sync' }],
        [{ text: activeExtreme ? '🛑 Stop Extreme' : '💥 Extreme Mode', callback_data: activeExtreme ? `extreme:stop:${activeExtreme.chatId}` : 'menu:extreme' }],
      ]
    }
  };
}

function walletMenu() {
  const buttons = Object.values(state.wallets).map(w => [
    {
      text: `${w.id === state.activeWalletId ? '✅ ' : ''}${w.name} (${shortKey(w.pubkey)})`,
      callback_data: `wallet:switch:${w.id}`
    },
    {
      text: '🗑️',
      callback_data: `wallet:delete:${w.id}`
    }
  ]);
  buttons.push([{ text: '➕ Import Wallet Baru', callback_data: 'wallet:import' }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'menu:main' }]);
  const headerText = buttons.length > 0
    ? '💼 WALLET MANAGER\n━━━━━━━━━━━━━━━━━━━━\n\nPilih wallet aktif atau import baru:'
    : '💼 WALLET MANAGER\n━━━━━━━━━━━━━━━━━━━━\n\n📭 Belum ada wallet. Import dulu!';
  return { text: headerText, markup: { inline_keyboard: buttons } };
}


function stratMenu() {
  const presets = Object.values(state.presets);
  const buttons = presets.map(p => [{
    text: `${p.name === state.activePresetId ? '✅ ' : ''}${p.name} (${p.sol === 'max' ? 'MAX' : (typeof p.sol === 'string' && p.sol.endsWith('%')) ? p.sol + ' bal' : p.sol + ' SOL'} | -${p.range}% | ${p.strategy})`,
    callback_data: `strat:switch:${p.name}`
  }]);
  buttons.push([{ text: '➕ Tambah Strat', callback_data: 'strat:add' }]);
  buttons.push([{ text: '✏️ Edit Strat', callback_data: 'strat:edit_list' }, { text: '🗑️ Hapus Strat', callback_data: 'strat:delete_list' }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'menu:main' }]);
  return { text: '⚡ STRATEGY PRESETS\n━━━━━━━━━━━━━━━━━━━━\n\nPilih atau kelola preset:', markup: { inline_keyboard: buttons } };
}

function positionCard(posKey, posData, status) {
  const si = posData.solAmount > 0 ? `${posData.solAmount} SOL` : 'Unknown';
  const ri = posData.rangePercent > 0 ? `-${posData.rangePercent}%` : `${posData.maxBinId - posData.minBinId} bins`;
  return {
    text: `📊 POSISI AKTIF\n━━━━━━━━━━━━━━━━━━━━\n🏊 Pool: ${shortKey(posData.poolAddress)}\n📍 Position: ${shortKey(posKey)}\n💰 SOL: ${si} | Range: ${ri}\n📊 Bins: ${posData.minBinId} → ${posData.maxBinId}\n📐 Strategy: ${posData.strategyStr.toUpperCase()}\n📈 Status: ${status?.inRange ? '✅ In Range' : '⚠️ Out of Range'}\n🕐 Added: ${new Date(posData.addedAt).toLocaleString('id-ID')}\n━━━━━━━━━━━━━━━━━━━━`,
    markup: {
      inline_keyboard: [
        [{ text: '🗑️ Remove LP', callback_data: `pos:remove:${posKey}` }, { text: '🔄 Refresh', callback_data: `pos:status:${posKey}` }],
        [{ text: '🔙 Back', callback_data: 'menu:positions' }]
      ]
    }
  };
}

const userState = {};
const USER_STATE_TTL = 10 * 60 * 1000; // 10 menit
function setUserState(chatId, val) {
  if (userState[chatId]?.timeoutHandle) clearTimeout(userState[chatId].timeoutHandle);
  const timeoutHandle = setTimeout(() => {
    clearUserState(chatId);
  }, USER_STATE_TTL);
  userState[chatId] = { ...val, timeoutHandle };
}
function clearUserState(chatId) {
  if (userState[chatId]?.timeoutHandle) clearTimeout(userState[chatId].timeoutHandle);
  delete userState[chatId];
}

async function handleTgMessage(chatId, text, messageId) {
  chatIds.add(chatId);
  const us = userState[chatId];

  if (us?.step === 'extreme_pool') {
    clearUserState(chatId);
    const poolAddress = extractPoolAddress(text.trim());
    if (!poolAddress) return tgSend(chatId, '❌ Pool address tidak valid.');
    const solAmount = us.data.solAmount;
    await tgSend(chatId, `💥 Starting Extreme Mode...\n🏊 Pool: ${shortKey(poolAddress)}\n💰 ${solAmount === 'max' ? '99% balance' : solAmount + ' SOL'}\n🎯 1 bin | BidAsk | 2.5s monitor`);
    try {
      const result = await openExtremePosition(poolAddress, solAmount);
      extremeSessions[chatId] = { chatId, poolAddress, positionKey: result.positionKey, targetBinId: result.targetBinId, solAmount, status: 'active', cycleCount: 0 };
      extremeSessions[chatId].timer = setTimeout(() => extremeMonitorTick(chatId), MONITOR_INTERVAL);
      return tgSend(chatId,
        `✅ EXTREME MODE AKTIF!\n━━━━━━━━━━━━━━━━━━━━\n📍 Position: ${shortKey(result.positionKey)}\n🎯 Target bin: ${result.targetBinId}\n💰 SOL: ${result.solUsed}\n🔗 Tx: ${result.txHash}\n\nBot monitor tiap 2.5 detik. Klik stop kalau mau berhenti.`,
        { inline_keyboard: [[{ text: '🛑 Stop Extreme', callback_data: `extreme:stop:${chatId}` }]] }
      );
    } catch (e) { return tgSend(chatId, `❌ Error: ${e.message}`); }
  }

  if (us?.step === 'strat_name') {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const added = [];
    let lastAdded = null;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const [sname, ssol, srange, sstrat] = parts;
      const sol = ssol === 'max' ? 'max' : ssol.endsWith('%') ? ssol : parseFloat(ssol);
      const range = parseFloat(srange);
      const solValid = sol === 'max' || (typeof sol === 'string' && sol.endsWith('%')) || (!isNaN(sol) && sol > 0);
      if (!solValid || isNaN(range)) continue;
      addPreset(sname, sname, sol, range, sstrat);
      added.push(sname);
      lastAdded = sname;
    }
    if (added.length === 0) return tgSend(chatId, '❌ Format salah! Coba lagi:\n<nama> <sol|max> <range%> <spot|curve|bidask>\n\nContoh:\nSETORAN max 7 bidask\nSAFE 1 30 spot');
    clearUserState(chatId);
    if (lastAdded) switchPreset(lastAdded);
    return tgSend(chatId,
      `✅ ${added.length} strat ditambahkan!\n${added.map(s => `• ${s}`).join('\n')}\n\nAktif: ${lastAdded}`,
      { inline_keyboard: [[{ text: '⚡ Lihat Strats', callback_data: 'menu:strat' }], [{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] }
    );
  }

  if (us?.step === 'strat_edit') {
    const targetId = us.data.id;
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) return tgSend(chatId, '❌ Format salah! Coba lagi:\n<sol|max> <range%> <spot|curve|bidask>\n\nContoh: max 7 bidask');
    const [ssol, srange, sstrat] = parts;
    const sol = ssol === 'max' ? 'max' : ssol.endsWith('%') ? ssol : parseFloat(ssol);
    const range = parseFloat(srange);
    const solValid = sol === 'max' || (typeof sol === 'string' && sol.endsWith('%')) || (!isNaN(sol) && sol > 0);
    if (!solValid || isNaN(range)) return tgSend(chatId, '❌ Format SOL salah! Coba lagi:\n<sol|max|50%> <range%> <spot|curve|bidask>');
    clearUserState(chatId);
    addPreset(targetId, targetId, sol, range, sstrat);
    const sm = stratMenu();
    return tgSend(chatId, `✅ Strat "${targetId}" diupdate!\n💰 ${solLabel(sol)} | -${range}% | ${sstrat}`, sm.markup);
  }

  if (us?.step === 'import_name') {
    const nameInput = text.trim();
    // Detect if user accidentally sent PK instead of name (base58, 64-88 chars)
    if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(nameInput)) {
      return tgSend(chatId, '❌ Itu kayaknya private key, bukan nama!\n\nKetik nama wallet dulu (contoh: "Main", "Trading"):');
    }
    if (nameInput.length > 30) {
      return tgSend(chatId, '❌ Nama terlalu panjang, maksimal 30 karakter:');
    }
    setUserState(chatId, { step: 'import_pk', data: { name: nameInput } });
    return tgSend(chatId, `✏️ Kirim Private Key wallet "${nameInput}":\n\n⚠️ Hapus pesan PK kamu setelah dikirim!`);
  }

  if (us?.step === 'import_pk') {
    const name = us.data.name;
    // Auto-delete the message containing the PK immediately
    if (messageId) tgDelete(chatId, messageId).catch(() => {});
    try {
      const result = addWallet(name, text.trim());
      clearUserState(chatId);
      return tgSend(chatId, `✅ Wallet "${name}" berhasil diimport!\nAddress: ${shortKey(result.pubkey)}\n\n🗑️ Pesan PK kamu sudah otomatis dihapus.`,
        { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] });
    } catch (e) { return tgSend(chatId, `❌ Private key tidak valid, coba kirim ulang: ${e.message}`); }
  }

  if (isPoolInput(text)) {
    if (userState[chatId]?.step) return; // lagi di flow input, skip
    const wallet = getActiveWallet();
    if (!wallet) return tgSend(chatId, '❌ Import wallet dulu!');
    const poolAddress = extractPoolAddress(text);
    if (!poolAddress) return tgSend(chatId, '❌ Pool address tidak valid.');
    const preset = getActivePreset();
    await tgSend(chatId, `⚡ Auto AddLP...\n🏊 Pool: ${shortKey(poolAddress)}\n💰 ${solLabel(preset.sol)} | -${preset.range}% | ${preset.strategy}`);
    try {
      const result = await addLiquidity(poolAddress, preset.sol, preset.range, preset.strategy);
      const card = positionCard(result.positionKey, state.positions[result.positionKey], { inRange: true });
      return tgSend(chatId,
        `✅ LP Added!\n━━━━━━━━━━━━━━━━━━━━\n📍 Position: ${shortKey(result.positionKey)}\n💰 SOL Used: ${result.solUsed}\n📊 Bins: ${result.minBinId} - ${result.maxBinId}\n🔗 Tx: ${result.txHash}`,
        card.markup);
    } catch (e) { return tgSend(chatId, `❌ Error: ${e.message}`); }
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    const menu = mainMenu(getActiveWallet());
    return tgSend(chatId, menu.text, menu.markup);
  }
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const msgId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  chatIds.add(chatId);
  await tgAnswer(callbackQuery.id);
  const parts = data.split(':');
  const ns = parts[0], action = parts[1], param = parts.slice(2).join(':');

  try {
    if (data === 'menu:main') { const menu = mainMenu(getActiveWallet()); return tgEdit(chatId, msgId, menu.text, menu.markup); }
    if (data === 'menu:balance') {
      const wallet = getActiveWallet();
      if (!wallet) return tgEdit(chatId, msgId, '❌ Belum ada wallet aktif.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] });
      const bal = await getSolBalance(wallet.publicKey.toBase58());
      return tgEdit(chatId, msgId,
        `💰 BALANCE\n━━━━━━━━━━━━━━━━━━━━\n💼 ${state.wallets[state.activeWalletId]?.name}\n📍 ${shortKey(wallet.publicKey.toBase58())}\n\n💎 ${bal.toFixed(4)} SOL`,
        { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] });
    }
    if (data === 'menu:rpc') {
      await tgEdit(chatId, msgId, '⏳ Mengecek RPC speed...');
      const results = await Promise.all(RPC_LIST.map(r => pingRpc(r.url)));
      results.sort((a, b) => a.ms - b.ms);
      let msg = '🌐 RPC SPEED TEST\n━━━━━━━━━━━━━━━━━━━━\n\n';
      results.forEach((r, i) => {
        const label = RPC_LIST.find(x => x.url === r.url)?.label || 'Unknown';
        msg += `${['🥇','🥈','🥉'][i]} ${label}: ${r.ms === 99999 ? 'timeout' : r.ms + 'ms'}\n`;
      });
      connection = new Connection(results[0].url, 'confirmed');
      msg += `\n✅ Active: ${RPC_LIST.find(x => x.url === results[0].url)?.label}`;
      return tgEdit(chatId, msgId, msg, { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] });
    }
    if (data === 'menu:sync') {
      await tgEdit(chatId, msgId, '⏳ Syncing posisi dari chain...');
      const result = await syncPositions();
      return tgEdit(chatId, msgId,
        `🔄 SYNC SELESAI\n━━━━━━━━━━━━━━━━━━━━\n\n✅ ${result.added} posisi baru\n🗑️ ${result.removed} posisi dihapus\n📊 On-chain: ${result.total}\n📋 Tracked: ${Object.keys(state.positions).length}`,
        { inline_keyboard: [[{ text: '📊 Lihat Posisi', callback_data: 'menu:positions' }], [{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] });
    }
    if (data === 'menu:addlp') {
      return tgEdit(chatId, msgId,
        `➕ ADD LP\n━━━━━━━━━━━━━━━━━━━━\n\n⚡ AUTO: Paste link pool langsung di chat\nhttps://app.meteora.ag/dlmm/...\n\nAkan pakai strat aktif saat ini.`,
        { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] });
    }
    if (data === 'menu:positions') {
      const positions = Object.entries(state.positions);
      if (positions.length === 0) {
        return tgEdit(chatId, msgId, '📊 POSISI\n━━━━━━━━━━━━━━━━━━━━\n\n📭 Tidak ada posisi aktif.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] });
      }
      const buttons = positions.map(([key, pos]) => [{ text: `🏊 ${shortKey(pos.poolAddress)} — ${pos.solAmount > 0 ? pos.solAmount + ' SOL' : 'synced'}`, callback_data: `pos:view:${key}` }]);
      buttons.push([{ text: '🔙 Back', callback_data: 'menu:main' }]);
      return tgEdit(chatId, msgId, `📊 POSISI AKTIF\n━━━━━━━━━━━━━━━━━━━━\n\n${positions.length} posisi:`, { inline_keyboard: buttons });
    }
    if (data === 'menu:wallet') { const wMenu = walletMenu(); return tgEdit(chatId, msgId, wMenu.text, wMenu.markup); }
    if (data === 'menu:strat') { const sm = stratMenu(); return tgEdit(chatId, msgId, sm.text, sm.markup); }
    if (data === 'menu:extreme') {
      const preset = getActivePreset();
      if (!preset) {
        return tgEdit(chatId, msgId,
          '💥 EXTREME MODE\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ Belum ada preset! Buat preset dulu di menu Strategy, atau pakai MAX SOL langsung.',
          { inline_keyboard: [
            [{ text: '💰 Pakai MAX SOL', callback_data: 'extreme:start:max' }],
            [{ text: '⚡ Buat Preset Dulu', callback_data: 'menu:strat' }],
            [{ text: '🔙 Back', callback_data: 'menu:main' }]
          ]}
        );
      }
      return tgEdit(chatId, msgId,
        `💥 EXTREME MODE\n━━━━━━━━━━━━━━━━━━━━\n\n🎯 1 bin | BidAsk | Auto-rebalance\n⏱️ Monitor: 2.5 detik\n💰 SOL: ${solLabel(preset.sol)}\n\n⚠️ Mode ini agresif! Bot akan terus rebalance selama aktif.\n\nPaste link pool untuk mulai:`,
        { inline_keyboard: [[{ text: `💰 Pakai ${solLabel(preset.sol)} (preset aktif)`, callback_data: `extreme:start:${encodeURIComponent(preset.sol)}` }], [{ text: '🔙 Back', callback_data: 'menu:main' }]] }
      );
    }

    if (ns === 'extreme' && action === 'start') {
      const decoded = decodeURIComponent(param); setUserState(chatId, { step: 'extreme_pool', data: { solAmount: decoded === 'max' ? 'max' : decoded.endsWith('%') ? decoded : parseFloat(decoded) } });
      return tgEdit(chatId, msgId, `💥 EXTREME MODE\n━━━━━━━━━━━━━━━━━━━━\n\nPaste link pool Meteora:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:main' }]] });
    }
    if (ns === 'extreme' && action === 'stop') {
      const targetChatId = parseInt(param);
      if (isNaN(targetChatId)) return tgEdit(chatId, msgId, '❌ Session tidak valid.', { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] });
      stopExtremeSession(targetChatId);
      return tgEdit(chatId, msgId,
        `🛑 EXTREME MODE DIHENTIKAN\n━━━━━━━━━━━━━━━━━━━━\n\nTotal cycles: ${extremeSessions[targetChatId]?.cycleCount || 0}\n\n⚠️ Posisi masih aktif on-chain! Gunakan menu Posisi untuk remove jika perlu.`,
        { inline_keyboard: [[{ text: '📊 Lihat Posisi', callback_data: 'menu:positions' }], [{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] }
      );
    }

    if (ns === 'strat' && action === 'switch') { if (!state.presets[param]) return tgEdit(chatId, msgId, '❌ Preset tidak ditemukan.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:strat' }]] }); switchPreset(param); const p = state.presets[param]; const sm = stratMenu(); return tgEdit(chatId, msgId, `✅ Strat aktif: ${p.name}\n💰 ${solLabel(p.sol)} | -${p.range}% | ${p.strategy}\n\n` + sm.text, sm.markup); }
    if (ns === 'strat' && action === 'add') { setUserState(chatId, { step: 'strat_name' }); return tgEdit(chatId, msgId, '➕ TAMBAH STRAT\n━━━━━━━━━━━━━━━━━━━━\n\nKetik 1 atau beberapa strat (1 per baris):\n<nama> <sol|max|50%> <range%> <spot|curve|bidask>\n\nContoh:\nSETORAN max 7 bidask\nSAFE 1 30 spot\nSCALP 50% 5 bidask', { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:strat' }]] }); }
    if (ns === 'strat' && action === 'edit_list') {
      const presets = Object.values(state.presets);
      const buttons = presets.map(p => [{ text: `✏️ ${p.name} (${p.sol === 'max' ? 'MAX' : (typeof p.sol === 'string' && p.sol.endsWith('%')) ? p.sol + ' bal' : p.sol + ' SOL'} | -${p.range}% | ${p.strategy})`, callback_data: `strat:edit:${p.name}` }]);
      buttons.push([{ text: '🔙 Back', callback_data: 'menu:strat' }]);
      return tgEdit(chatId, msgId, '✏️ EDIT STRAT\n━━━━━━━━━━━━━━━━━━━━\n\nPilih strat yang mau diedit:', { inline_keyboard: buttons });
    }
    if (ns === 'strat' && action === 'edit') { const p = state.presets[param]; if (!p) return tgEdit(chatId, msgId, '❌ Preset tidak ditemukan.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:strat' }]] }); setUserState(chatId, { step: 'strat_edit', data: { id: param } }); return tgEdit(chatId, msgId, `✏️ Edit strat "${param}"\nSekarang: ${solLabel(p.sol)} | -${p.range}% | ${p.strategy}\n\nKetik nilai baru:\n<sol|max|50%> <range%> <spot|curve|bidask>`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'strat:edit_list' }]] }); }
    if (ns === 'strat' && action === 'delete_list') {
      const presets = Object.values(state.presets);
      if (presets.length === 0) return tgEdit(chatId, msgId, '❌ Tidak ada strat yang bisa dihapus.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:strat' }]] });
      const buttons = presets.map(p => [{ text: `🗑️ ${p.name} (${p.sol === 'max' ? 'MAX' : (typeof p.sol === 'string' && p.sol.endsWith('%')) ? p.sol + ' bal' : p.sol + ' SOL'} | -${p.range}% | ${p.strategy})`, callback_data: `strat:delete:${p.name}` }]);
      buttons.push([{ text: '🔙 Back', callback_data: 'menu:strat' }]);
      return tgEdit(chatId, msgId, '🗑️ HAPUS STRAT\n━━━━━━━━━━━━━━━━━━━━\n\nPilih strat yang mau dihapus:', { inline_keyboard: buttons });
    }
    if (ns === 'strat' && action === 'delete') { deletePreset(param); const sm = stratMenu(); return tgEdit(chatId, msgId, `✅ Strat "${param}" dihapus.\n\n` + sm.text, sm.markup); }

    if (ns === 'wallet' && action === 'import') { setUserState(chatId, { step: 'import_name' }); return tgEdit(chatId, msgId, '💼 IMPORT WALLET\n━━━━━━━━━━━━━━━━━━━━\n\nKetik nama untuk wallet ini:', { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:wallet' }]] }); }
    if (ns === 'wallet' && action === 'switch') { switchWallet(param); const wMenu = walletMenu(); return tgEdit(chatId, msgId, `✅ Wallet aktif: ${state.wallets[param]?.name}\n\n` + wMenu.text, wMenu.markup); }
    if (ns === 'wallet' && action === 'delete') {
      const w = state.wallets[param];
      if (!w) return tgEdit(chatId, msgId, '❌ Wallet tidak ditemukan.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:wallet' }]] });
      return tgEdit(chatId, msgId,
        `🗑️ Hapus wallet "${w.name}"?\n📍 ${w.pubkey}\n\n⚠️ Private key akan dihapus dari .env!`,
        { inline_keyboard: [
          [{ text: '✅ Ya, hapus', callback_data: `wallet:confirmdelete:${param}` }, { text: '❌ Batal', callback_data: 'menu:wallet' }]
        ]}
      );
    }
    if (ns === 'wallet' && action === 'confirmdelete') {
      const w = state.wallets[param];
      const name = w?.name || param;
      deleteWallet(param);
      const wMenu = walletMenu();
      return tgEdit(chatId, msgId, `✅ Wallet "${name}" dihapus.\n\n` + wMenu.text, wMenu.markup);
    }

    if (ns === 'pos' && (action === 'view' || action === 'status')) {
      const posData = state.positions[param];
      if (!posData) return tgEdit(chatId, msgId, '❌ Position tidak ditemukan.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:positions' }]] });
      const status = await getPositionStatus(param);
      const card = positionCard(param, posData, status);
      return tgEdit(chatId, msgId, card.text, card.markup);
    }
    if (ns === 'pos' && action === 'remove') {
      await tgEdit(chatId, msgId, `⏳ Removing LP...\n📍 ${shortKey(param)}`);
      const txHashes = await removeLiquidity(param);
      return tgEdit(chatId, msgId, `✅ LP Removed!\n━━━━━━━━━━━━━━━━━━━━\n🔗 Tx: ${txHashes[0]}`, { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] });
    }
  } catch (e) {
    console.error('[Callback] Error:', e.message);
    tgEdit(chatId, msgId, `❌ Error: ${e.message}`, { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] }).catch(() => {});
  }
}

let tgOffset = 0;
async function tgPoll() {
  try {
    const data = await fetchJSON(`${TELEGRAM_API}/getUpdates?offset=${tgOffset}&timeout=30`);
    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        tgOffset = update.update_id + 1;
        if (update.message?.text) handleTgMessage(update.message.chat.id, update.message.text, update.message.message_id).catch(e => console.error('[TG]', e.message));
        if (update.callback_query) handleCallback(update.callback_query).catch(e => console.error('[Callback]', e.message));
      }
    }
  } catch (e) { console.error('[TG] Poll error:', e.message); }
  setTimeout(tgPoll, 1000);
}

async function start() {
  if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN tidak ditemukan di .env! Pastikan file .env ada dan berisi TELEGRAM_TOKEN=...');
    process.exit(1);
  }

  // Auto-load wallets from env (WALLET_1, WALLET_2, etc) if not already in state
  let i = 1;
  while (process.env[`WALLET_${i}`]) {
    const envKey = `WALLET_${i}`;
    const pk = process.env[envKey];
    // Check if this envKey is already tracked
    const alreadyTracked = Object.values(state.wallets).some(w => w.envKey === envKey);
    if (!alreadyTracked) {
      try {
        const kp = Keypair.fromSecretKey(bs58.default.decode(pk));
        const id = kp.publicKey.toBase58().slice(0, 8);
        state.wallets[id] = { id, name: `Wallet ${i}`, pubkey: kp.publicKey.toBase58(), envKey };
        if (!state.activeWalletId) state.activeWalletId = id;
        console.log(`[Wallet] Loaded ${envKey}: ${kp.publicKey.toBase58()}`);
      } catch (e) {
        console.error(`[Wallet] Gagal load ${envKey}: ${e.message}`);
      }
    }
    i++;
  }
  saveData();

  console.log('🌐 Finding best RPC...');
  connection = new Connection(await getBestRpc(), 'confirmed');
  const wallet = getActiveWallet();
  if (wallet) console.log(`💼 Active wallet: ${wallet.publicKey.toBase58()}`);
  console.log('🌊 Meteora Bot starting...');
  tgPoll();
}

start();
