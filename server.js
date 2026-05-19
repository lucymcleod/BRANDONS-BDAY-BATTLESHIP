// Brandon's Birthday Battleship — server
// Holds both players' fleets secretly. Each player only sees their own board
// and shots fired at the other player's grid (with reveals on hits).

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.send('ok'));

// ---------- GAME STATE (single shared game) ----------
const GRID_SIZE = 10;
const SHIPS = [
  { id: 'dragon',     name: 'Dragon Roll',     size: 5, emoji: '🐉' },
  { id: 'rainbow',    name: 'Rainbow Roll',    size: 4, emoji: '🌈' },
  { id: 'california', name: 'California Roll', size: 4, emoji: '🥑' },
  { id: 'spicy',      name: 'Spicy Tuna',      size: 3, emoji: '🌶️' },
  { id: 'salmon',     name: 'Salmon Nigiri',   size: 3, emoji: '🍣' },
  { id: 'tempura',    name: 'Tempura Roll',    size: 3, emoji: '🍤' },
  { id: 'eel',        name: 'Eel Nigiri',      size: 2, emoji: '🍙' },
  { id: 'edamame',    name: 'Edamame Boat',    size: 2, emoji: '🫛' },
];

function emptyBoard() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}
function freshFleet() {
  return SHIPS.map(s => ({ ...s, placed: false, cells: [], hits: 0, sunk: false }));
}

// One persistent game state for the two known players: 'lucy' and 'brandon'
const game = {
  players: {
    lucy:    { name: 'Lucy',    fleet: freshFleet(), board: emptyBoard(), shotsAgainst: emptyBoard(), revealed: emptyBoard(), ready: false, penalty: 0, sunkDetails: [] },
    brandon: { name: 'Brandon', fleet: freshFleet(), board: emptyBoard(), shotsAgainst: emptyBoard(), revealed: emptyBoard(), ready: false, penalty: 0, sunkDetails: [] },
  },
  // 'lucy' goes first by default; flip on miss
  turn: 'lucy',
  phase: 'placement', // 'placement' | 'play' | 'ended'
  winner: null,
  log: [],
};

// active WebSocket connections by player id
const connections = { lucy: null, brandon: null };

function otherPlayer(p) { return p === 'lucy' ? 'brandon' : 'lucy'; }

// Build the personalised view for one player.
// They see: their own board (with ships), their own incoming shots,
// and the enemy grid showing only their own shots + revealed hits/sinks.
function viewFor(playerId) {
  const me = game.players[playerId];
  const them = game.players[otherPlayer(playerId)];
  return {
    you: playerId,
    yourName: me.name,
    opponentName: them.name,
    phase: game.phase,
    turn: game.turn,
    winner: game.winner,
    // your own waters: full board, with shots fired against you
    ownBoard: me.board,
    shotsAgainstYou: me.shotsAgainst,
    // enemy waters: your shots against them, plus revealed sushi at hits/sinks
    shotsByYou: them.shotsAgainst, // shots against THEM = shots BY YOU
    revealedAtEnemy: them.revealed,
    // fleet status (yours fully, theirs only sunk count)
    yourFleet: me.fleet,
    opponentFleetSunk: them.fleet.filter(s => s.sunk).map(s => ({ name: s.name, size: s.size, emoji: s.emoji })),
    opponentShipsTotal: them.fleet.length,
    opponentShipsAfloat: them.fleet.filter(s => !s.sunk).length,
    // penalties
    yourPenalty: me.penalty,
    opponentPenalty: them.penalty,
    yourSunkDetails: me.sunkDetails,
    opponentSunkDetails: them.sunkDetails,
    // readiness
    youReady: me.ready,
    opponentReady: them.ready,
    // log (shared, but hit details on enemy moves are sanitised below)
    log: game.log,
  };
}

function sendStateTo(playerId) {
  const ws = connections[playerId];
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'state', state: viewFor(playerId) }));
  }
}
function broadcastState() {
  sendStateTo('lucy');
  sendStateTo('brandon');
}

function sendToastTo(playerId, toast) {
  const ws = connections[playerId];
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'toast', toast }));
  }
}

// ---------- VALIDATION HELPERS ----------
function getShipCells(r, c, size, orient) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    if (orient === 'H') cells.push([r, c + i]);
    else cells.push([r + i, c]);
  }
  return cells;
}
function cellsValid(cells, board) {
  return cells.every(([r, c]) =>
    r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE && board[r][c] === null
  );
}

// Auto-place all remaining ships randomly (used by client "auto-place" button via server)
function autoPlaceFor(playerId) {
  const p = game.players[playerId];
  p.board = emptyBoard();
  p.fleet = freshFleet();
  for (const ship of p.fleet) {
    let placed = false, attempts = 0;
    while (!placed && attempts < 300) {
      attempts++;
      const orient = Math.random() < 0.5 ? 'H' : 'V';
      const r = Math.floor(Math.random() * GRID_SIZE);
      const c = Math.floor(Math.random() * GRID_SIZE);
      const cells = getShipCells(r, c, ship.size, orient);
      if (cellsValid(cells, p.board)) {
        cells.forEach(([cr, cc]) => p.board[cr][cc] = ship.id);
        ship.cells = cells;
        ship.placed = true;
        placed = true;
      }
    }
  }
}

// ---------- WEBSOCKET HANDLING ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Identify player from query string ?player=lucy or ?player=brandon
  const url = new URL(req.url, 'http://x');
  const playerId = (url.searchParams.get('player') || '').toLowerCase();

  if (playerId !== 'lucy' && playerId !== 'brandon') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid player. Use ?player=lucy or ?player=brandon' }));
    ws.close();
    return;
  }

  // If someone is already connected as this player, replace them (allows reconnect)
  if (connections[playerId] && connections[playerId].readyState === connections[playerId].OPEN) {
    try { connections[playerId].close(); } catch (e) {}
  }
  connections[playerId] = ws;
  console.log(`[connect] ${playerId}`);

  // Send initial state
  sendStateTo(playerId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'place_ship') {
      if (game.phase !== 'placement') return;
      const p = game.players[playerId];
      if (p.ready) return;
      const { shipId, row, col, orientation } = msg;
      const ship = p.fleet.find(s => s.id === shipId);
      if (!ship || ship.placed) return;
      const cells = getShipCells(row, col, ship.size, orientation);
      if (!cellsValid(cells, p.board)) return;
      cells.forEach(([r, c]) => p.board[r][c] = ship.id);
      ship.cells = cells;
      ship.placed = true;
      sendStateTo(playerId);
    }

    else if (msg.type === 'reset_placement') {
      if (game.phase !== 'placement') return;
      const p = game.players[playerId];
      if (p.ready) return;
      p.board = emptyBoard();
      p.fleet = freshFleet();
      sendStateTo(playerId);
    }

    else if (msg.type === 'auto_place') {
      if (game.phase !== 'placement') return;
      const p = game.players[playerId];
      if (p.ready) return;
      autoPlaceFor(playerId);
      sendStateTo(playerId);
    }

    else if (msg.type === 'confirm_fleet') {
      if (game.phase !== 'placement') return;
      const p = game.players[playerId];
      if (p.fleet.every(s => s.placed)) {
        p.ready = true;
        // If both ready, move to play phase
        if (game.players.lucy.ready && game.players.brandon.ready) {
          game.phase = 'play';
          game.log.unshift('⚔️ Fleets locked in. Battle begins!');
        }
        broadcastState();
      }
    }

    else if (msg.type === 'fire') {
      if (game.phase !== 'play') return;
      if (game.turn !== playerId) return;
      const attacker = game.players[playerId];
      const defenderId = otherPlayer(playerId);
      const defender = game.players[defenderId];
      const { row, col } = msg;
      if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) return;
      if (defender.shotsAgainst[row][col]) return; // already fired
      const coord = `${String.fromCharCode(65 + col)}${row + 1}`;
      const target = defender.board[row][col];

      if (target) {
        defender.shotsAgainst[row][col] = 'hit';
        defender.revealed[row][col] = target;
        const ship = defender.fleet.find(s => s.id === target);
        ship.hits++;

        // Toasts: attacker sees what they hit, defender sees what was hit on their fleet
        sendToastTo(playerId,    { kind: 'hit', ship: { name: ship.name, emoji: ship.emoji, size: ship.size }, role: 'attacker', opponentName: defender.name });
        sendToastTo(defenderId,  { kind: 'hit', ship: { name: ship.name, emoji: ship.emoji, size: ship.size }, role: 'defender', opponentName: attacker.name });
        game.log.unshift(`${attacker.name} fires at ${coord} → HIT! It's a ${ship.emoji} ${ship.name}`);

        if (ship.hits >= ship.size) {
          ship.sunk = true;
          ship.cells.forEach(([r, c]) => {
            defender.shotsAgainst[r][c] = 'sunk';
            defender.revealed[r][c] = ship.id;
          });
          defender.penalty += ship.size;
          defender.sunkDetails.push({ name: ship.name, size: ship.size, emoji: ship.emoji });
          sendToastTo(playerId,   { kind: 'sunk', ship: { name: ship.name, emoji: ship.emoji, size: ship.size }, role: 'attacker', opponentName: defender.name });
          sendToastTo(defenderId, { kind: 'sunk', ship: { name: ship.name, emoji: ship.emoji, size: ship.size }, role: 'defender', opponentName: attacker.name });
          game.log.unshift(`💥 SUNK! ${defender.name}'s ${ship.name} (${ship.size} pcs) — eat ${ship.size} pieces!`);

          if (defender.fleet.every(s => s.sunk)) {
            game.phase = 'ended';
            game.winner = playerId;
            game.log.unshift(`🏁 ${attacker.name} wins! ${defender.name} owes ${defender.penalty} pieces of sushi.`);
          }
        }
        // hits give another turn (classic rule)
      } else {
        defender.shotsAgainst[row][col] = 'miss';
        game.log.unshift(`${attacker.name} fires at ${coord} → miss.`);
        game.turn = defenderId; // swap turn
      }

      broadcastState();
    }

    else if (msg.type === 'reset_game') {
      // Either player can reset after game ends
      if (game.phase === 'ended') {
        for (const id of ['lucy', 'brandon']) {
          const p = game.players[id];
          p.fleet = freshFleet();
          p.board = emptyBoard();
          p.shotsAgainst = emptyBoard();
          p.revealed = emptyBoard();
          p.ready = false;
          p.penalty = 0;
          p.sunkDetails = [];
        }
        game.turn = 'lucy';
        game.phase = 'placement';
        game.winner = null;
        game.log = [];
        broadcastState();
      }
    }
  });

  ws.on('close', () => {
    if (connections[playerId] === ws) {
      connections[playerId] = null;
      console.log(`[disconnect] ${playerId}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Brandon's Birthday Battleship running on port ${PORT}`);
});
