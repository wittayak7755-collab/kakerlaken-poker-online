// server.js — Node.js / Express / Socket.io — Kakerlaken Poker (Cockroach Poker) online
// Authoritative server: real card identities never sent to clients until a round resolves.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const ANIMALS = [
  'cockroach', 'fly', 'rat', 'bat', 'frog', 'scorpion', 'spider', 'stinkbug'
];
const COPIES_PER_ANIMAL = 8;
const MAX_FACEUP_BEFORE_LOSS = 4;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function buildDeck() {
  const deck = [];
  for (const animal of ANIMALS) {
    for (let i = 0; i < COPIES_PER_ANIMAL; i++) deck.push(animal);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.players = []; // { id(socketId), name, hand:[animal], faceUp:{animal:count}, connected }
    this.phase = 'lobby'; // lobby | playing | ended
    this.turnIndex = 0;
    this.pending = null; // active card in transit, see startRound()
    this.log = [];
    this.winnerMessage = null;
  }

  player(id) { return this.players.find(p => p.id === id); }
  playerIndex(id) { return this.players.findIndex(p => p.id === id); }
  alivePlayers() { return this.players; } // elimination ends game immediately, so always full list

  addLog(line) {
    this.log.push(line);
    if (this.log.length > 60) this.log.shift();
  }

  currentPlayer() { return this.players[this.turnIndex]; }

  startGame() {
    const deck = buildDeck();
    this.players.forEach(p => { p.hand = []; p.faceUp = {}; });
    let i = 0;
    while (deck.length) {
      this.players[i % this.players.length].hand.push(deck.pop());
      i++;
    }
    this.phase = 'playing';
    this.turnIndex = Math.floor(Math.random() * this.players.length);
    this.pending = null;
    this.log = [];
    this.winnerMessage = null;
    this.addLog(`game started — ${this.players.length} players, ${this.players.reduce((a, p) => a + p.hand.length, 0)} cards dealt`);
  }

  // current turn player picks a card from own hand and sends face down to target, with a claim
  playCard(fromId, cardIndex, targetId, claimedAnimal) {
    if (this.phase !== 'playing') return { error: 'game not in progress' };
    const cur = this.currentPlayer();
    if (!cur || cur.id !== fromId) return { error: 'not your turn' };
    if (this.pending) return { error: 'a card is already in transit' };
    const from = this.player(fromId);
    const target = this.player(targetId);
    if (!target || target.id === fromId) return { error: 'invalid target' };
    if (cardIndex < 0 || cardIndex >= from.hand.length) return { error: 'invalid card index' };
    if (!ANIMALS.includes(claimedAnimal)) return { error: 'invalid animal claim' };

    const [actualAnimal] = from.hand.splice(cardIndex, 1);
    this.pending = {
      actualAnimal,
      claimedAnimal,
      originSenderId: fromId,   // who picked it from their hand originally — "owner" of first claim
      claimantId: fromId,       // whoever made the CURRENT claim (updates on each re-pass)
      holderId: targetId,       // who currently holds it and must decide
      chain: [fromId, targetId] // everyone who has touched this card, can't boomerang back
    };
    this.addLog(`${from.name} passes a card face down to ${target.name}`);
    return { ok: true };
  }

  // holder peeks and passes along to someone new, optionally re-declaring the claim
  passAlong(holderId, nextTargetId, newClaimedAnimal) {
    if (this.phase !== 'playing' || !this.pending) return { error: 'no card in transit' };
    const p = this.pending;
    if (p.holderId !== holderId) return { error: 'you are not holding the card' };
    if (p.chain.includes(nextTargetId)) return { error: 'cannot pass back to someone already in the chain' };
    const nextTarget = this.player(nextTargetId);
    if (!nextTarget || nextTargetId === holderId) return { error: 'invalid target' };
    if (!ANIMALS.includes(newClaimedAnimal)) return { error: 'invalid animal claim' };

    p.claimantId = holderId;
    p.claimedAnimal = newClaimedAnimal;
    p.holderId = nextTargetId;
    p.chain.push(nextTargetId);
    this.addLog(`${this.player(holderId).name} looks, then passes it on to ${nextTarget.name}`);
    return { ok: true };
  }

  // holder commits to a guess: does the claimed animal match the real one?
  makeGuess(holderId, guessTruth) {
    if (this.phase !== 'playing' || !this.pending) return { error: 'no card in transit' };
    const p = this.pending;
    if (p.holderId !== holderId) return { error: 'you are not holding the card' };

    const guesser = this.player(holderId);
    const claimant = this.player(p.claimantId);
    const wasTrue = p.actualAnimal === p.claimedAnimal;
    const guessedCorrectly = guessTruth === wasTrue;

    // correct guess -> claimant (the one being judged) takes the card face up
    // wrong guess -> guesser takes the card face up
    const loser = guessedCorrectly ? claimant : guesser;
    loser.faceUp[p.actualAnimal] = (loser.faceUp[p.actualAnimal] || 0) + 1;

    this.addLog(
      `${guesser.name} calls it "${guessTruth ? 'true' : 'lie'}" — ` +
      `it was actually ${p.actualAnimal} (claimed ${p.claimedAnimal}). ` +
      `${guesser.name} guessed ${guessedCorrectly ? 'correctly' : 'wrong'} — ` +
      `${loser.name} takes it face up.`
    );

    const revealed = { actualAnimal: p.actualAnimal, claimedAnimal: p.claimedAnimal, loserId: loser.id, loserName: loser.name, guesserId: guesser.id, guessedCorrectly };
    this.pending = null;

    // loss check: 4 face-up of same animal
    if (loser.faceUp[p.actualAnimal] >= MAX_FACEUP_BEFORE_LOSS) {
      this.endGame(`${loser.name} collected 4 ${p.actualAnimal} face up and loses!`);
      return { ok: true, revealed, gameOver: true };
    }

    // next turn is the loser's turn (they start the next round)
    this.turnIndex = this.playerIndex(loser.id);
    this.checkEmptyHandLoss();
    return { ok: true, revealed, gameOver: this.phase === 'ended' };
  }

  // if it becomes someone's turn with an empty hand, they lose immediately
  checkEmptyHandLoss() {
    if (this.phase !== 'playing') return;
    const cur = this.currentPlayer();
    if (cur && cur.hand.length === 0) {
      this.endGame(`${cur.name} has no cards left on their turn and loses!`);
    }
  }

  endGame(message) {
    this.phase = 'ended';
    this.winnerMessage = message;
    this.addLog(message);
  }

  publicState(forId) {
    return {
      code: this.code,
      phase: this.phase,
      hostSocketId: this.hostSocketId,
      turnPlayerId: this.players[this.turnIndex] ? this.players[this.turnIndex].id : null,
      winnerMessage: this.winnerMessage,
      log: this.log,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        handCount: p.hand ? p.hand.length : 0,
        faceUp: p.faceUp || {},
        hand: p.id === forId ? p.hand : undefined // only reveal own hand
      })),
      pending: this.pending ? {
        holderId: this.pending.holderId,
        claimantId: this.pending.claimantId,
        originSenderId: this.pending.originSenderId,
        claimedAnimal: this.pending.claimedAnimal,
        chain: this.pending.chain,
        // actualAnimal deliberately withheld unless you ARE the holder deciding, and even then
        // the client doesn't need it until resolution — server resolves guesses itself.
      } : null
    };
  }

  broadcastState() {
    for (const p of this.players) {
      io.to(p.id).emit('state', this.publicState(p.id));
    }
  }
}

function emitError(socket, message) {
  socket.emit('errorMsg', message);
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createRoom', ({ name }) => {
    const code = makeRoomCode();
    const room = new Room(code, socket.id);
    room.players.push({ id: socket.id, name: (name || 'Player').slice(0, 20), hand: [], faceUp: {}, connected: true });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    room.broadcastState();
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return emitError(socket, 'room not found');
    if (room.phase !== 'lobby') return emitError(socket, 'game already started');
    if (room.players.length >= MAX_PLAYERS) return emitError(socket, 'room is full');
    room.players.push({ id: socket.id, name: (name || 'Player').slice(0, 20), hand: [], faceUp: {}, connected: true });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    room.broadcastState();
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return emitError(socket, 'not in a room');
    if (room.hostSocketId !== socket.id) return emitError(socket, 'only the host can start the game');
    if (room.players.length < MIN_PLAYERS) return emitError(socket, `need at least ${MIN_PLAYERS} players`);
    room.startGame();
    room.broadcastState();
  });

  socket.on('playCard', ({ cardIndex, targetId, claimedAnimal }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return emitError(socket, 'not in a room');
    const res = room.playCard(socket.id, cardIndex, targetId, claimedAnimal);
    if (res.error) return emitError(socket, res.error);
    room.broadcastState();
  });

  socket.on('passAlong', ({ nextTargetId, claimedAnimal }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return emitError(socket, 'not in a room');
    const res = room.passAlong(socket.id, nextTargetId, claimedAnimal);
    if (res.error) return emitError(socket, res.error);
    room.broadcastState();
  });

  socket.on('makeGuess', ({ guessTruth }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return emitError(socket, 'not in a room');
    const res = room.makeGuess(socket.id, !!guessTruth);
    if (res.error) return emitError(socket, res.error);
    room.broadcastState();
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return emitError(socket, 'not in a room');
    if (room.hostSocketId !== socket.id) return emitError(socket, 'only the host can restart');
    room.phase = 'lobby';
    room.players.forEach(p => { p.hand = []; p.faceUp = {}; });
    room.pending = null;
    room.winnerMessage = null;
    room.log = [];
    room.broadcastState();
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.player(socket.id);
    if (p) p.connected = false;
    // keep the room alive (reconnect isn't implemented client-side yet, but state persists
    // for the rest of the session so a refresh+rejoin-by-code still works for others)
    if (room.players.every(pl => !pl.connected)) {
      rooms.delete(room.code);
    } else {
      room.broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`kakerlaken poker online listening on :${PORT}`));
