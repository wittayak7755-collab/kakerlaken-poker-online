// client.js — browser-side UI + socket wiring for Kakerlaken Poker Online

const ANIMAL_EMOJI = {
  cockroach: '🪳', fly: '🪰', rat: '🐀', bat: '🦇',
  frog: '🐸', scorpion: '🦂', spider: '🕷️', stinkbug: '🐞'
};
const ANIMAL_LABEL_TH = {
  cockroach: 'แมลงสาบ', fly: 'แมลงวัน', rat: 'หนู', bat: 'ค้างคาว',
  frog: 'กบ', scorpion: 'แมงป่อง', spider: 'แมงมุม', stinkbug: 'แมลงแคง'
};
const ANIMALS = Object.keys(ANIMAL_EMOJI);

const socket = io();
let myId = null;
let latestState = null;
let selectedCardIndex = null;
let selectedTargetId = null;
let selectedAnimal = null;
let selectedGuessMode = 'play'; // 'play' = initial send, 'pass' = re-pass after peeking

const $ = (sel) => document.querySelector(sel);
const show = (id) => { ['screen-home','screen-lobby','screen-game','screen-end'].forEach(s => $('#'+s).classList.toggle('hidden', s !== id)); };

socket.on('connect', () => { myId = socket.id; });

socket.on('errorMsg', (msg) => {
  const homeErr = $('#homeError');
  if (homeErr) homeErr.textContent = msg;
  else alert(msg);
});

$('#btnCreate').onclick = () => {
  const name = $('#nameInput').value.trim() || 'Player';
  socket.emit('createRoom', { name });
};
$('#btnJoin').onclick = () => {
  const name = $('#nameInput').value.trim() || 'Player';
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) { $('#homeError').textContent = 'ใส่รหัสห้องด้วย'; return; }
  socket.emit('joinRoom', { code, name });
};
$('#btnStart').onclick = () => socket.emit('startGame');
$('#btnRestart').onclick = () => socket.emit('restartGame');

socket.on('state', (state) => {
  latestState = state;
  if (state.phase === 'lobby') renderLobby(state);
  else if (state.phase === 'playing') renderGame(state);
  else if (state.phase === 'ended') renderEnd(state);
});

function renderLobby(state) {
  show('screen-lobby');
  $('#lobbyCode').textContent = state.code;
  const ul = $('#lobbyPlayers');
  ul.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    const isHost = p.id === state.hostSocketId;
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.id === myId ? ' (คุณ)' : ''}</span><span class="tag">${isHost ? 'หัวห้อง' : ''}${p.connected ? '' : ' • หลุดการเชื่อมต่อ'}</span>`;
    ul.appendChild(li);
  });
  const isHost = state.hostSocketId === myId;
  const btn = $('#btnStart');
  btn.classList.toggle('hidden', !isHost);
  btn.disabled = state.players.length < 2;
  $('#lobbyHint').textContent = isHost
    ? (state.players.length < 2 ? 'ต้องมีผู้เล่นอย่างน้อย 2 คน' : `พร้อมเริ่ม — ${state.players.length} ผู้เล่น`)
    : 'รอหัวห้องกดเริ่มเกม';
}

function renderEnd(state) {
  show('screen-end');
  $('#endMessage').textContent = state.winnerMessage || 'เกมจบแล้ว';
  const isHost = state.hostSocketId === myId;
  $('#btnRestart').classList.toggle('hidden', !isHost);
  $('#endHint').textContent = isHost ? '' : 'รอหัวห้องกดเล่นใหม่';
}

function renderGame(state) {
  show('screen-game');
  const me = state.players.find(p => p.id === myId);
  const turnPlayer = state.players.find(p => p.id === state.turnPlayerId);
  const myTurn = state.turnPlayerId === myId;

  $('#turnBanner').textContent = myTurn ? '🔥 ตาของคุณ' : `⏳ ตาของ ${turnPlayer ? turnPlayer.name : '-'}`;
  $('#turnBanner').classList.toggle('mine', myTurn);

  // opponents strip
  const opp = $('#opponents');
  opp.innerHTML = '';
  state.players.filter(p => p.id !== myId).forEach(p => {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.id === state.turnPlayerId ? ' turn' : '');
    const faceUpChips = Object.entries(p.faceUp || {}).map(([a, n]) =>
      `<span class="chip${n >= 4 ? ' danger' : ''}">${ANIMAL_EMOJI[a]} x${n}</span>`).join('');
    div.innerHTML = `<div class="name">${escapeHtml(p.name)}${p.connected ? '' : ' 💤'}</div>
      <div>มือ: ${p.handCount} ใบ</div>
      <div class="faceup">${faceUpChips}</div>`;
    opp.appendChild(div);
  });

  renderPending(state, me, myTurn);
  renderHand(state, me, myTurn);
  renderLog(state);
}

function renderPending(state, me, myTurn) {
  const pb = $('#pendingBanner');
  const ap = $('#actionPanel');
  if (!state.pending) {
    pb.classList.add('hidden');
    if (!myTurn) { ap.classList.add('hidden'); ap.innerHTML = ''; }
    else renderPlayAction(state, me);
    return;
  }
  const p = state.pending;
  const claimant = state.players.find(x => x.id === p.claimantId);
  const holder = state.players.find(x => x.id === p.holderId);
  pb.classList.remove('hidden');
  pb.textContent = `🃏 ${claimant.name} บอกว่าเป็น "${ANIMAL_LABEL_TH[p.claimedAnimal]}" ${ANIMAL_EMOJI[p.claimedAnimal]} → ส่งให้ ${holder.name} ตัดสินใจ`;

  if (p.holderId === myId) {
    renderHolderAction(state, p);
  } else {
    ap.classList.add('hidden');
    ap.innerHTML = '';
  }
}

function renderPlayAction(state, me) {
  const ap = $('#actionPanel');
  ap.classList.remove('hidden');
  selectedGuessMode = 'play';
  const others = state.players.filter(p => p.id !== myId);
  ap.innerHTML = `
    <h4>เลือกไพ่จากมือ แล้วส่งให้ใครสักคน พร้อมประกาศว่าเป็นสัตว์อะไร</h4>
    <div>เป้าหมาย:</div>
    <div class="target-grid">${others.map(p => `<button class="target-btn" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div>
    <div>ประกาศว่าเป็น (จะพูดจริงหรือตอแหลก็ได้):</div>
    <div class="animal-grid">${ANIMALS.map(a => `<button class="animal-btn" data-animal="${a}"><span class="emoji">${ANIMAL_EMOJI[a]}</span>${ANIMAL_LABEL_TH[a]}</button>`).join('')}</div>
    <button id="confirmPlay" class="primary" disabled>ส่งไพ่</button>
  `;
  wireTargetAndAnimalPickers(ap, () => {
    $('#confirmPlay').disabled = !(selectedCardIndex !== null && selectedTargetId && selectedAnimal);
  });
  $('#confirmPlay').onclick = () => {
    socket.emit('playCard', { cardIndex: selectedCardIndex, targetId: selectedTargetId, claimedAnimal: selectedAnimal });
    resetSelections();
  };
}

function renderHolderAction(state, pending) {
  const ap = $('#actionPanel');
  ap.classList.remove('hidden');
  const others = state.players.filter(p => p.id !== myId && !pending.chain.includes(p.id));
  selectedGuessMode = 'holder';
  ap.innerHTML = `
    <h4>คุณถือไพ่ใบนี้อยู่ — ทายว่าจริงหรือโกหก หรือแอบดูแล้วส่งต่อ</h4>
    <div class="guess-row">
      <button class="true-btn" id="guessTrue">✅ เชื่อ</button>
      <button class="lie-btn" id="guessLie">🤥 ตอแหล</button>
    </div>
    ${others.length ? `
      <div style="margin-top:16px">หรือแอบดูไพ่แล้วส่งต่อ (ห้ามส่งกลับคนที่เคยส่งมา):</div>
      <div class="target-grid">${others.map(p => `<button class="target-btn" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div>
      <div>ประกาศใหม่ว่าเป็น:</div>
      <div class="animal-grid">${ANIMALS.map(a => `<button class="animal-btn" data-animal="${a}"><span class="emoji">${ANIMAL_EMOJI[a]}</span>${ANIMAL_LABEL_TH[a]}</button>`).join('')}</div>
      <button id="confirmPass" class="primary" disabled>ส่งต่อ</button>
    ` : `<p class="hint">ไม่มีใครให้ส่งต่อแล้ว ต้องทายเท่านั้น</p>`}
  `;
  $('#guessTrue').onclick = () => { socket.emit('makeGuess', { guessTruth: true }); resetSelections(); };
  $('#guessLie').onclick = () => { socket.emit('makeGuess', { guessTruth: false }); resetSelections(); };
  if (others.length) {
    wireTargetAndAnimalPickers(ap, () => {
      $('#confirmPass').disabled = !(selectedTargetId && selectedAnimal);
    }, true);
    $('#confirmPass').onclick = () => {
      socket.emit('passAlong', { nextTargetId: selectedTargetId, claimedAnimal: selectedAnimal });
      resetSelections();
    };
  }
}

function wireTargetAndAnimalPickers(root, onChange, skipCardSelect) {
  root.querySelectorAll('.target-btn').forEach(btn => {
    btn.onclick = () => {
      selectedTargetId = btn.dataset.id;
      root.querySelectorAll('.target-btn').forEach(b => b.classList.toggle('selected', b === btn));
      onChange();
    };
  });
  root.querySelectorAll('.animal-btn').forEach(btn => {
    btn.onclick = () => {
      selectedAnimal = btn.dataset.animal;
      root.querySelectorAll('.animal-btn').forEach(b => b.classList.toggle('selected', b === btn));
      onChange();
    };
  });
}

function renderHand(state, me, myTurn) {
  $('#handCount').textContent = me ? me.hand.length : 0;
  const handDiv = $('#hand');
  handDiv.innerHTML = '';
  if (!me || !me.hand) return;
  const canSelect = myTurn && !state.pending;
  me.hand.forEach((animal, idx) => {
    const d = document.createElement('div');
    d.className = 'hand-card' + (!canSelect ? ' disabled' : '') + (selectedCardIndex === idx ? ' selected' : '');
    d.innerHTML = `<span class="corner tl">${ANIMAL_EMOJI[animal]}</span>
      <span class="emoji">${ANIMAL_EMOJI[animal]}</span>
      <span class="label">${ANIMAL_LABEL_TH[animal]}</span>
      <span class="corner br">${ANIMAL_EMOJI[animal]}</span>`;
    if (canSelect) {
      d.onclick = () => {
        selectedCardIndex = idx;
        document.querySelectorAll('.hand-card').forEach((c, i) => c.classList.toggle('selected', i === idx));
        const confirmBtn = $('#confirmPlay');
        if (confirmBtn) confirmBtn.disabled = !(selectedCardIndex !== null && selectedTargetId && selectedAnimal);
      };
    }
    handDiv.appendChild(d);
  });
}

function renderLog(state) {
  const log = $('#log');
  log.innerHTML = state.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function resetSelections() {
  selectedCardIndex = null;
  selectedTargetId = null;
  selectedAnimal = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
