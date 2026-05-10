import React, { useEffect, useMemo, useRef, useState } from "react";

type Color = "white" | "black";
type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";
type Difficulty = "Easy" | "Medium" | "Hard";
type Mode = "human" | "cpu";
type Square = `${"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"}${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

type Piece = {
  id: string;
  type: PieceType;
  color: Color;
  moved: boolean;
  promotedFromPawn?: boolean;
};

type SecretInfo = {
  pieceId: string;
  revealed: boolean;
  initialSquare: Square;
};

type Move = {
  from: Square;
  to?: Square;
  kind: "move" | "selfCapture" | "reveal";
  promotion?: Exclude<PieceType, "K" | "P">;
};

type PendingPromotion = {
  square: Square;
  color: Color;
  moveBase: Move;
};

type State = {
  board: Record<Square, Piece | null>;
  turn: Color;
  selected: Square | null;
  flipped: boolean;
  quietus: { white: Piece[]; black: Piece[] };
  mode: Mode;
  cpuColor: Color;
  difficulty: Difficulty;
  status: string;
  winner: Color | null;
  result: string | null;
  showInfo: boolean;
  secrets: { white: SecretInfo; black: SecretInfo };
  peek: "none" | Color;
  pendingPromotion: PendingPromotion | null;
  enPassantTarget: Square | null;
  lastMove: { from?: Square; to?: Square; kind: Move["kind"] } | null;
};

type WorkerRequest = {
  type: "pickMove";
  requestId: number;
  state: State;
};

type WorkerResponse = {
  type: "pickMoveResult";
  requestId: number;
  nextState: State;
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS_ASC = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const RANKS_DESC = [8, 7, 6, 5, 4, 3, 2, 1] as const;
const PROMOTION_TYPES: Exclude<PieceType, "K" | "P">[] = ["Q", "R", "B", "N"];

const GLYPHS: Record<Color, Record<PieceType, string>> = {
  white: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" },
  black: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" },
};



const WOOD_LIGHT = "#dcc4a1";
const PANEL = "#f4f1ec";
const PANEL_2 = "#e8e4de";
const ACCENT = "#b07a52";
const PAGE_BG = "#f6f1ea";
const TEXT = "#3a332c";
const BORDER = "#d8cfc2";
const LOGO_SRC = "/logo-paranoia.svg";

const other = (c: Color): Color => (c === "white" ? "black" : "white");
const keyOf = (f: number, r: number) => `${FILES[f]}${r}` as Square;
const coords = (sq: Square) => ({
  f: FILES.indexOf(sq[0] as (typeof FILES)[number]),
  r: Number(sq[1]),
});
const inBounds = (f: number, r: number) => f >= 0 && f < 8 && r >= 1 && r <= 8;
const originalColorFromPieceId = (pieceId: string): Color => (pieceId.startsWith("w-") ? "white" : "black");
const canBePurgedTarget = (piece: Piece | null) => !!piece && (piece.type === "P" || piece.type === "B" || piece.type === "N" || !!piece.promotedFromPawn);
const pieceName = (type: PieceType) => ({ K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" }[type]);

function cloneBoard(board: Record<Square, Piece | null>) {
  const out = {} as Record<Square, Piece | null>;
  for (const file of FILES) {
    for (const rank of RANKS_ASC) {
      const sq = `${file}${rank}` as Square;
      out[sq] = board[sq] ? { ...board[sq]! } : null;
    }
  }
  return out;
}

function cloneState(state: State): State {
  return {
    ...state,
    board: cloneBoard(state.board),
    quietus: {
      white: state.quietus.white.map((p) => ({ ...p })),
      black: state.quietus.black.map((p) => ({ ...p })),
    },
    secrets: {
      white: { ...state.secrets.white },
      black: { ...state.secrets.black },
    },
    pendingPromotion: state.pendingPromotion ? { ...state.pendingPromotion } : null,
    enPassantTarget: state.enPassantTarget,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
  };
}

function createInitialBoard() {
  const board = {} as Record<Square, Piece | null>;
  for (const file of FILES) {
    for (const rank of RANKS_ASC) {
      board[`${file}${rank}` as Square] = null;
    }
  }

  const back: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let i = 0; i < 8; i++) {
    board[`${FILES[i]}1` as Square] = { id: `w-${back[i]}-${i}`, type: back[i], color: "white", moved: false };
    board[`${FILES[i]}2` as Square] = { id: `w-P-${i}`, type: "P", color: "white", moved: false };
    board[`${FILES[i]}8` as Square] = { id: `b-${back[i]}-${i}`, type: back[i], color: "black", moved: false };
    board[`${FILES[i]}7` as Square] = { id: `b-P-${i}`, type: "P", color: "black", moved: false };
  }

  return board;
}

function randomFrom<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function createSecrets(board: Record<Square, Piece | null>): State["secrets"] {
  const whitePool: Array<{ piece: Piece; square: Square }> = [];
  const blackPool: Array<{ piece: Piece; square: Square }> = [];

  for (const sq of Object.keys(board) as Square[]) {
    const p = board[sq];
    if (!p) continue;
    if (p.type === "P" || p.type === "B" || p.type === "N") {
      if (p.color === "white") whitePool.push({ piece: { ...p }, square: sq });
      else blackPool.push({ piece: { ...p }, square: sq });
    }
  }

  const whiteSecret = randomFrom(blackPool);
  const blackSecret = randomFrom(whitePool);

  return {
    white: { pieceId: whiteSecret.piece.id, revealed: false, initialSquare: whiteSecret.square },
    black: { pieceId: blackSecret.piece.id, revealed: false, initialSquare: blackSecret.square },
  };
}

function initialState(): State {
  const board = createInitialBoard();
  return {
    board,
    turn: "white",
    selected: null,
    flipped: false,
    quietus: { white: [], black: [] },
    mode: "cpu",
    cpuColor: "black",
    difficulty: "Medium",
    status: "White to move",
    winner: null,
    result: null,
    showInfo: false,
    secrets: createSecrets(board),
    peek: "none",
    pendingPromotion: null,
    enPassantTarget: null,
    lastMove: null,
  };
}

function findKing(board: Record<Square, Piece | null>, color: Color) {
  return (Object.keys(board) as Square[]).find((sq) => board[sq]?.type === "K" && board[sq]?.color === color) || null;
}

function getCastlingRookSquares(color: Color, side: "king" | "queen") {
  if (color === "white") {
    return side === "king"
      ? { rookFrom: "h1" as Square, rookTo: "f1" as Square }
      : { rookFrom: "a1" as Square, rookTo: "d1" as Square };
  }
  return side === "king"
    ? { rookFrom: "h8" as Square, rookTo: "f8" as Square }
    : { rookFrom: "a8" as Square, rookTo: "d8" as Square };
}

function maybePromotion(piece: Piece, to: Square) {
  const rank = Number(to[1]);
  return piece.type === "P" && ((piece.color === "white" && rank === 8) || (piece.color === "black" && rank === 1));
}

function rayMoves(board: Record<Square, Piece | null>, from: Square, color: Color, dirs: number[][], allowSelf: boolean) {
  const { f, r } = coords(from);
  const out: Move[] = [];

  for (const [df, dr] of dirs) {
    let nf = f + df;
    let nr = r + dr;

    while (inBounds(nf, nr)) {
      const to = keyOf(nf, nr);
      const hit = board[to];
      if (!hit) {
        out.push({ from, to, kind: "move" });
      } else {
        if (hit.color !== color) out.push({ from, to, kind: "move" });
        else if (allowSelf && canBePurgedTarget(hit)) out.push({ from, to, kind: "selfCapture" });
        break;
      }
      nf += df;
      nr += dr;
    }
  }

  return out;
}

function pseudoMoves(state: State, color: Color, allowSelf = false, forAttackOnly = false) {
  const board = state.board;
  const out: Move[] = [];

  for (const sq of Object.keys(board) as Square[]) {
    const p = board[sq];
    if (!p || p.color !== color) continue;
    const { f, r } = coords(sq);

    if (p.type === "P") {
      const dir = color === "white" ? 1 : -1;
      const one = r + dir;

      if (!forAttackOnly && inBounds(f, one) && !board[keyOf(f, one)]) {
        out.push({ from: sq, to: keyOf(f, one), kind: "move" });
        const two = r + dir * 2;
        const startRank = color === "white" ? 2 : 7;
        if (r === startRank && inBounds(f, two) && !board[keyOf(f, two)] && !board[keyOf(f, one)]) {
          out.push({ from: sq, to: keyOf(f, two), kind: "move" });
        }
      }

      for (const df of [-1, 1]) {
        const nf = f + df;
        const nr = r + dir;
        if (!inBounds(nf, nr)) continue;
        const to = keyOf(nf, nr);
        const hit = board[to];

        if (forAttackOnly) {
          out.push({ from: sq, to, kind: "move" });
          continue;
        }
        if (hit && hit.color !== color) {
          out.push({ from: sq, to, kind: "move" });
          continue;
        }
        if (allowSelf && hit && hit.color === color && canBePurgedTarget(hit)) {
          out.push({ from: sq, to, kind: "selfCapture" });
          continue;
        }
        if (!hit && state.enPassantTarget === to) {
          const capturedSq = keyOf(nf, r);
          const captured = board[capturedSq];
          if (captured && captured.type === "P" && captured.color === other(color)) {
            out.push({ from: sq, to, kind: "move" });
          }
        }
      }
      continue;
    }

    if (p.type === "N") {
      const jumps = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
      for (const [df, dr] of jumps) {
        const nf = f + df;
        const nr = r + dr;
        if (!inBounds(nf, nr)) continue;
        const to = keyOf(nf, nr);
        const hit = board[to];
        if (!hit || hit.color !== color) out.push({ from: sq, to, kind: "move" });
        else if (allowSelf && canBePurgedTarget(hit)) out.push({ from: sq, to, kind: "selfCapture" });
      }
      continue;
    }

    if (p.type === "B") {
      out.push(...rayMoves(board, sq, color, [[1, 1], [-1, 1], [1, -1], [-1, -1]], allowSelf));
      continue;
    }
    if (p.type === "R") {
      out.push(...rayMoves(board, sq, color, [[1, 0], [-1, 0], [0, 1], [0, -1]], allowSelf));
      continue;
    }
    if (p.type === "Q") {
      out.push(...rayMoves(board, sq, color, [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]], allowSelf));
      continue;
    }

    if (p.type === "K") {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (!df && !dr) continue;
          const nf = f + df;
          const nr = r + dr;
          if (!inBounds(nf, nr)) continue;
          const to = keyOf(nf, nr);
          const hit = board[to];
          if (!hit || hit.color !== color) out.push({ from: sq, to, kind: "move" });
          else if (allowSelf && canBePurgedTarget(hit)) out.push({ from: sq, to, kind: "selfCapture" });
        }
      }

      if (!forAttackOnly && !p.moved) {
        const enemy = other(color);
        const homeRank = color === "white" ? 1 : 8;
        if (r === homeRank && !squareAttacked(state, sq, enemy)) {
          const kingSide = [keyOf(f + 1, r), keyOf(f + 2, r)] as Square[];
          const kingRook = board[getCastlingRookSquares(color, "king").rookFrom];
          if (
            kingRook && kingRook.type === "R" && kingRook.color === color && !kingRook.moved &&
            kingSide.every((s) => !board[s]) &&
            !squareAttacked(state, kingSide[0], enemy) && !squareAttacked(state, kingSide[1], enemy)
          ) {
            out.push({ from: sq, to: kingSide[1], kind: "move" });
          }

          const queenBetween = [keyOf(f - 1, r), keyOf(f - 2, r), keyOf(f - 3, r)] as Square[];
          const queenTraverse = [keyOf(f - 1, r), keyOf(f - 2, r)] as Square[];
          const queenRook = board[getCastlingRookSquares(color, "queen").rookFrom];
          if (
            queenRook && queenRook.type === "R" && queenRook.color === color && !queenRook.moved &&
            queenBetween.every((s) => !board[s]) &&
            !squareAttacked(state, queenTraverse[0], enemy) && !squareAttacked(state, queenTraverse[1], enemy)
          ) {
            out.push({ from: sq, to: queenTraverse[1], kind: "move" });
          }
        }
      }
    }
  }

  return out;
}

function squareAttacked(state: State, target: Square, by: Color) {
  return pseudoMoves(state, by, false, true).some((m) => m.to === target);
}

function simulateMoveNoFinalize(state: State, move: Move): State {
  const next = cloneState(state);
  next.selected = null;
  next.pendingPromotion = null;
  next.lastMove = { kind: move.kind, from: move.from, to: move.to };
  next.enPassantTarget = null;
  next.status = "";

  if (move.kind === "reveal") {
    const secret = next.secrets[state.turn];
    if (secret.revealed) return next;
    const sq = (Object.keys(next.board) as Square[]).find((k) => next.board[k]?.id === secret.pieceId) || null;

    if (!sq) {
      next.status = `${state.turn} tried to reveal the fifth column, but it had already been removed`; 
      next.turn = other(state.turn);
      return next;
    }

    next.board[sq] = { ...next.board[sq]!, color: state.turn, moved: true };
    next.lastMove = { kind: "reveal", to: sq };
    secret.revealed = true;
    next.status = `${state.turn} revealed the fifth column on ${sq}`;
    next.turn = other(state.turn);
    return next;
  }

  const piece = next.board[move.from];
  if (!piece || piece.color !== state.turn || !move.to) return next;

  const fromCoords = coords(move.from);
  const toCoords = coords(move.to);
  let target = next.board[move.to];
  next.board[move.from] = null;

  if (piece.type === "P" && !target && state.enPassantTarget === move.to && fromCoords.f !== toCoords.f) {
    const captureSq = keyOf(toCoords.f, fromCoords.r);
    target = next.board[captureSq];
    next.board[captureSq] = null;
  }

  if (target) {
    const quietusColor = originalColorFromPieceId(target.id);
    next.quietus[quietusColor].push({ ...target });
    const enemyBeneficiary = other(target.color);
    const wasHiddenEnemyAsset = !next.secrets[enemyBeneficiary].revealed && next.secrets[enemyBeneficiary].pieceId === target.id;
    // Do not reveal fifth column information in status
      next.status = move.kind === "selfCapture"
        ? `${state.turn} purged a piece on ${move.to}`
        : `${state.turn} captured on ${move.to}`;
  }

  const movedPiece: Piece = { ...piece, moved: true };
  next.board[move.to] = movedPiece;

  if (piece.type === "K" && Math.abs(toCoords.f - fromCoords.f) === 2) {
    const side = toCoords.f > fromCoords.f ? "king" : "queen";
    const { rookFrom, rookTo } = getCastlingRookSquares(piece.color, side);
    const rook = next.board[rookFrom];
    if (rook) {
      next.board[rookFrom] = null;
      next.board[rookTo] = { ...rook, moved: true };
      next.status = `${state.turn} castled ${side}side`;
    }
  }

  if (piece.type === "P" && Math.abs(toCoords.r - fromCoords.r) === 2) {
    next.enPassantTarget = keyOf(fromCoords.f, fromCoords.r + (piece.color === "white" ? 1 : -1));
  }

  if (piece.type === "P" && state.enPassantTarget === move.to && fromCoords.f !== toCoords.f && !state.board[move.to]) {
    next.status = `${state.turn} captured en passant on ${move.to}`;
  }

  if (maybePromotion(movedPiece, move.to)) {
    if (move.promotion) {
      next.board[move.to] = { ...movedPiece, type: move.promotion, promotedFromPawn: true };
      next.status = `${state.turn} promoted on ${move.to}`;
      next.turn = other(state.turn);
      return next;
    }

    next.pendingPromotion = { square: move.to, color: movedPiece.color, moveBase: { ...move } };
    next.status = `${state.turn} must choose a promotion piece`; 
    return next;
  }

  next.turn = other(state.turn);
  if (!next.status) next.status = `${state.turn} moved ${piece.type.toLowerCase()} from ${move.from} to ${move.to}`;
  return next;
}

function perspectiveStateForCpu(state: State): State {
  if (state.mode !== "cpu") return state;
  const humanSide = other(state.cpuColor);
  if (state.secrets[humanSide].revealed) return state;

  const masked = cloneState(state);
  masked.secrets[humanSide] = {
    ...masked.secrets[humanSide],
    pieceId: "__hidden__",
  };
  return masked;
}

function legalMoves(state: State, color: Color): Move[] {
  const allowSelf = !state.secrets[other(color)].revealed;
  const candidates = pseudoMoves(state, color, allowSelf, false);
  const legal: Move[] = [];

  for (const move of candidates) {
    if (!move.to) continue;
    const piece = state.board[move.from];
    if (!piece) continue;

    const variants = maybePromotion(piece, move.to)
      ? PROMOTION_TYPES.map((promotion) => ({ ...move, promotion }))
      : [move];

    for (const variant of variants) {
      const next = simulateMoveNoFinalize({ ...state, turn: color }, variant);
      const kingSq = findKing(next.board, color);
      if (!kingSq) continue;
      if (!squareAttacked(next, kingSq, other(color))) legal.push(variant);
    }
  }

  if (!state.secrets[color].revealed && state.secrets[color].pieceId !== "__hidden__") {
    legal.push({ from: "a1", kind: "reveal" });
  }
  return legal;
}

function computeTerminalState(state: State): Pick<State, "winner" | "result" | "status"> {
  const current = state.turn;
  const currentKing = findKing(state.board, current);
  const enemyKing = findKing(state.board, other(current));

  if (!currentKing) return { winner: other(current), result: `${other(current)} wins`, status: `${state.status} ${other(current)} wins`.trim() };
  if (!enemyKing) return { winner: current, result: `${current} wins`, status: `${state.status} ${current} wins`.trim() };

  const nextLegal = legalMoves({ ...state, selected: null }, current);
  const inCheck = squareAttacked(state, currentKing, other(current));

  if (nextLegal.length === 0) {
    if (inCheck) return { winner: other(current), result: `${other(current)} wins by checkmate`, status: `${state.status} Checkmate`.trim() };
    return { winner: null, result: "Draw by stalemate", status: `${state.status} Stalemate`.trim() };
  }

  return { winner: null, result: null, status: inCheck ? `${state.status} ${current} is in check`.trim() : state.status };
}

function finalizeState(state: State): State {
  const terminal = computeTerminalState(state);
  return { ...state, winner: terminal.winner, result: terminal.result, status: terminal.status };
}

function applyMove(state: State, move: Move): State {
  return finalizeState(simulateMoveNoFinalize(state, move));
}

function humanMoveFromCandidates(candidates: Move[]): Move | null {
  if (!candidates.length) return null;
  const explicit = candidates.find((m) => !m.promotion);
  if (explicit) return explicit;
  const first = candidates[0];
  return { ...first, promotion: undefined };
}

function pieceValue(type: PieceType) {
  return { K: 20000, Q: 900, R: 500, B: 330, N: 320, P: 100 }[type];
}

function evaluate(state: State, forColor: Color) {
  if (state.result) {
    if (state.winner === forColor) return 999999;
    if (state.winner === other(forColor)) return -999999;
    return 0;
  }

  let score = 0;
  for (const sq of Object.keys(state.board) as Square[]) {
    const p = state.board[sq];
    if (!p) continue;
    score += p.color === forColor ? pieceValue(p.type) : -pieceValue(p.type);
    const { f, r } = coords(sq);
    const center = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 4.5));
    score += (p.color === forColor ? 1 : -1) * center * 3;
    if (p.promotedFromPawn) score += p.color === forColor ? 30 : -30;
  }
  if (!state.secrets[forColor].revealed) score += 20;
  if (!state.secrets[other(forColor)].revealed) score -= 20;
  return score;
}

function moveHeuristic(state: State, move: Move, color: Color) {
  if (move.kind === "reveal") return 60;
  if (!move.to) return 0;

  const piece = state.board[move.from];
  const target = state.board[move.to];
  let score = 0;

  if (target) {
    score += 10 * pieceValue(target.type) - (piece ? pieceValue(piece.type) : 0);
  }

  if (!target && state.enPassantTarget === move.to) score += 120;
  if (move.promotion) score += pieceValue(move.promotion) + 200;

  return score;
}

function orderMoves(state: State, moves: Move[], color: Color) {
  return [...moves].sort((a, b) => moveHeuristic(state, b, color) - moveHeuristic(state, a, color));
}

function minimax(state: State, depth: number, alpha: number, beta: number, maximizing: boolean, root: Color): number {
  if (depth === 0 || state.result) return evaluate(state, root);

  const side = maximizing ? root : other(root);
  const viewedState = perspectiveStateForCpu({ ...state, turn: side });
  let moves = legalMoves(viewedState, side);
  if (!moves.length) return evaluate(finalizeState({ ...state, turn: side }), root);
  moves = orderMoves(viewedState, moves, side);

  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      const next = applyMove(viewedState, move);
      const score = minimax(next, depth - 1, alpha, beta, false, root);
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    const next = applyMove(viewedState, move);
    const score = minimax(next, depth - 1, alpha, beta, true, root);
    best = Math.min(best, score);
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function pickCpuMove(state: State) {
  const color = state.cpuColor;
  const viewedState = perspectiveStateForCpu({ ...state, turn: color });
  let moves = legalMoves(viewedState, color);
  if (!moves.length) return finalizeState({ ...state, turn: color });
  moves = orderMoves(viewedState, moves, color);

  if (moves.length === 1) return applyMove(state, moves[0]);
  if (state.difficulty === "Easy") {
    const captures = moves.filter((m) => m.to && (state.board[m.to] || state.enPassantTarget === m.to));
    return applyMove(state, captures[0] || moves[0]);
  }

  const depth = state.difficulty === "Hard" ? 2 : 1;

  let best = -Infinity;
  let bestMove = moves[0];

  for (const move of moves) {
    const next = applyMove(state, move);
    const score = minimax(next, depth, -Infinity, Infinity, false, color);
    if (score > best) {
      best = score;
      bestMove = move;
    }
  }

  return applyMove(state, bestMove);
}

function createCpuWorker() {
  const workerSource = `
    const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const RANKS_ASC = [1, 2, 3, 4, 5, 6, 7, 8];
    const PROMOTION_TYPES = ["Q", "R", "B", "N"];
    const other = (c) => (c === "white" ? "black" : "white");
    const keyOf = (f, r) => FILES[f] + r;
    const coords = (sq) => ({ f: FILES.indexOf(sq[0]), r: Number(sq[1]) });
    const inBounds = (f, r) => f >= 0 && f < 8 && r >= 1 && r <= 8;
    const canBePurgedTarget = (piece) => !!piece && (piece.type === "P" || piece.type === "B" || piece.type === "N" || !!piece.promotedFromPawn);
    const cloneBoard = (board) => {
      const out = {};
      for (const file of FILES) {
        for (const rank of RANKS_ASC) {
          const sq = file + rank;
          out[sq] = board[sq] ? { ...board[sq] } : null;
        }
      }
      return out;
    };
    const cloneState = (state) => ({
      ...state,
      board: cloneBoard(state.board),
      quietus: {
        white: state.quietus.white.map((p) => ({ ...p })),
        black: state.quietus.black.map((p) => ({ ...p })),
      },
      secrets: {
        white: { ...state.secrets.white },
        black: { ...state.secrets.black },
      },
      pendingPromotion: state.pendingPromotion ? { ...state.pendingPromotion } : null,
      enPassantTarget: state.enPassantTarget,
      lastMove: state.lastMove ? { ...state.lastMove } : null,
    });
    const findKing = (board, color) => Object.keys(board).find((sq) => board[sq]?.type === "K" && board[sq]?.color === color) || null;
    const getCastlingRookSquares = (color, side) => {
      if (color === "white") return side === "king" ? { rookFrom: "h1", rookTo: "f1" } : { rookFrom: "a1", rookTo: "d1" };
      return side === "king" ? { rookFrom: "h8", rookTo: "f8" } : { rookFrom: "a8", rookTo: "d8" };
    };
    const maybePromotion = (piece, to) => {
      const rank = Number(to[1]);
      return piece.type === "P" && ((piece.color === "white" && rank === 8) || (piece.color === "black" && rank === 1));
    };
    const rayMoves = (board, from, color, dirs, allowSelf) => {
      const { f, r } = coords(from);
      const out = [];
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (inBounds(nf, nr)) {
          const to = keyOf(nf, nr);
          const hit = board[to];
          if (!hit) {
            out.push({ from, to, kind: "move" });
          } else {
            if (hit.color !== color) out.push({ from, to, kind: "move" });
            else if (allowSelf && canBePurgedTarget(hit)) out.push({ from, to, kind: "selfCapture" });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
      return out;
    };
    const squareAttacked = (state, target, by) => pseudoMoves(state, by, false, true).some((m) => m.to === target);
    const pseudoMoves = (state, color, allowSelf = false, forAttackOnly = false) => {
      const board = state.board;
      const out = [];
      for (const sq of Object.keys(board)) {
        const p = board[sq];
        if (!p || p.color !== color) continue;
        const { f, r } = coords(sq);
        if (p.type === "P") {
          const dir = color === "white" ? 1 : -1;
          const one = r + dir;
          if (!forAttackOnly && inBounds(f, one) && !board[keyOf(f, one)]) {
            out.push({ from: sq, to: keyOf(f, one), kind: "move" });
            const two = r + dir * 2;
            const startRank = color === "white" ? 2 : 7;
            if (r === startRank && inBounds(f, two) && !board[keyOf(f, two)] && !board[keyOf(f, one)]) out.push({ from: sq, to: keyOf(f, two), kind: "move" });
          }
          for (const df of [-1, 1]) {
            const nf = f + df;
            const nr = r + dir;
            if (!inBounds(nf, nr)) continue;
            const to = keyOf(nf, nr);
            const hit = board[to];
            if (forAttackOnly) { out.push({ from: sq, to, kind: "move" }); continue; }
            if (hit && hit.color !== color) { out.push({ from: sq, to, kind: "move" }); continue; }
            if (allowSelf && hit && hit.color === color && canBePurgedTarget(hit)) { out.push({ from: sq, to, kind: "selfCapture" }); continue; }
            if (!hit && state.enPassantTarget === to) {
              const capturedSq = keyOf(nf, r);
              const captured = board[capturedSq];
              if (captured && captured.type === "P" && captured.color === other(color)) out.push({ from: sq, to, kind: "move" });
            }
          }
          continue;
        }
        if (p.type === "N") {
          const jumps = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
          for (const [df, dr] of jumps) {
            const nf = f + df;
            const nr = r + dr;
            if (!inBounds(nf, nr)) continue;
            const to = keyOf(nf, nr);
            const hit = board[to];
            if (!hit || hit.color !== color) out.push({ from: sq, to, kind: "move" });
            else if (allowSelf && canBePurgedTarget(hit)) out.push({ from: sq, to, kind: "selfCapture" });
          }
          continue;
        }
        if (p.type === "B") { out.push(...rayMoves(board, sq, color, [[1,1],[-1,1],[1,-1],[-1,-1]], allowSelf)); continue; }
        if (p.type === "R") { out.push(...rayMoves(board, sq, color, [[1,0],[-1,0],[0,1],[0,-1]], allowSelf)); continue; }
        if (p.type === "Q") { out.push(...rayMoves(board, sq, color, [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]], allowSelf)); continue; }
        if (p.type === "K") {
          for (let df = -1; df <= 1; df++) {
            for (let dr = -1; dr <= 1; dr++) {
              if (!df && !dr) continue;
              const nf = f + df;
              const nr = r + dr;
              if (!inBounds(nf, nr)) continue;
              const to = keyOf(nf, nr);
              const hit = board[to];
              if (!hit || hit.color !== color) out.push({ from: sq, to, kind: "move" });
              else if (allowSelf && canBePurgedTarget(hit)) out.push({ from: sq, to, kind: "selfCapture" });
            }
          }
          if (!forAttackOnly && !p.moved) {
            const enemy = other(color);
            const homeRank = color === "white" ? 1 : 8;
            if (r === homeRank && !squareAttacked(state, sq, enemy)) {
              const kingSide = [keyOf(f + 1, r), keyOf(f + 2, r)];
              const kingRook = board[getCastlingRookSquares(color, "king").rookFrom];
              if (kingRook && kingRook.type === "R" && kingRook.color === color && !kingRook.moved && kingSide.every((s) => !board[s]) && !squareAttacked(state, kingSide[0], enemy) && !squareAttacked(state, kingSide[1], enemy)) {
                out.push({ from: sq, to: kingSide[1], kind: "move" });
              }
              const queenBetween = [keyOf(f - 1, r), keyOf(f - 2, r), keyOf(f - 3, r)];
              const queenTraverse = [keyOf(f - 1, r), keyOf(f - 2, r)];
              const queenRook = board[getCastlingRookSquares(color, "queen").rookFrom];
              if (queenRook && queenRook.type === "R" && queenRook.color === color && !queenRook.moved && queenBetween.every((s) => !board[s]) && !squareAttacked(state, queenTraverse[0], enemy) && !squareAttacked(state, queenTraverse[1], enemy)) {
                out.push({ from: sq, to: queenTraverse[1], kind: "move" });
              }
            }
          }
        }
      }
      return out;
    };
    const simulateMoveNoFinalize = (state, move) => {
      const next = cloneState(state);
      next.selected = null;
      next.pendingPromotion = null;
      next.lastMove = { kind: move.kind, from: move.from, to: move.to };
      next.enPassantTarget = null;
      next.status = "";
      if (move.kind === "reveal") {
        const secret = next.secrets[state.turn];
        if (secret.revealed) return next;
        const sq = Object.keys(next.board).find((k) => next.board[k]?.id === secret.pieceId) || null;
        if (!sq) {
          next.status = state.turn + " tried to reveal the fifth column, but it had already been removed";
          next.turn = other(state.turn);
          return next;
        }
        next.board[sq] = { ...next.board[sq], color: state.turn, moved: true };
        next.lastMove = { kind: "reveal", to: sq };
        secret.revealed = true;
        next.status = state.turn + " revealed the fifth column on " + sq;
        next.turn = other(state.turn);
        return next;
      }
      const piece = next.board[move.from];
      if (!piece || piece.color !== state.turn || !move.to) return next;
      const fromCoords = coords(move.from);
      const toCoords = coords(move.to);
      let target = next.board[move.to];
      next.board[move.from] = null;
      if (piece.type === "P" && !target && state.enPassantTarget === move.to && fromCoords.f !== toCoords.f) {
        const captureSq = keyOf(toCoords.f, fromCoords.r);
        target = next.board[captureSq];
        next.board[captureSq] = null;
      }
      if (target) {
        const quietusColor = target.id.startsWith("w-") ? "white" : "black";
        next.quietus[quietusColor].push({ ...target });
        const enemyBeneficiary = other(target.color);
        const wasHiddenEnemyAsset = !next.secrets[enemyBeneficiary].revealed && next.secrets[enemyBeneficiary].pieceId === target.id;
        next.status = move.kind === "selfCapture"
          ? wasHiddenEnemyAsset
            ? state.turn + " purged their own piece on " + move.to + " - it was the opponent's fifth column"
            : state.turn + " purged their own piece on " + move.to
          : state.turn + " captured on " + move.to;
      }
      const movedPiece = { ...piece, moved: true };
      next.board[move.to] = movedPiece;
      if (piece.type === "K" && Math.abs(toCoords.f - fromCoords.f) === 2) {
        const side = toCoords.f > fromCoords.f ? "king" : "queen";
        const { rookFrom, rookTo } = getCastlingRookSquares(piece.color, side);
        const rook = next.board[rookFrom];
        if (rook) {
          next.board[rookFrom] = null;
          next.board[rookTo] = { ...rook, moved: true };
          next.status = state.turn + " castled " + side + "side";
        }
      }
      if (piece.type === "P" && Math.abs(toCoords.r - fromCoords.r) === 2) next.enPassantTarget = keyOf(fromCoords.f, fromCoords.r + (piece.color === "white" ? 1 : -1));
      if (piece.type === "P" && state.enPassantTarget === move.to && fromCoords.f !== toCoords.f && !state.board[move.to]) next.status = state.turn + " captured en passant on " + move.to;
      if (maybePromotion(movedPiece, move.to)) {
        if (move.promotion) {
          next.board[move.to] = { ...movedPiece, type: move.promotion, promotedFromPawn: true };
          next.status = state.turn + " promoted on " + move.to;
          next.turn = other(state.turn);
          return next;
        }
        next.pendingPromotion = { square: move.to, color: movedPiece.color, moveBase: { ...move } };
        next.status = state.turn + " must choose a promotion piece";
        return next;
      }
      next.turn = other(state.turn);
      if (!next.status) next.status = state.turn + " moved " + piece.type.toLowerCase() + " from " + move.from + " to " + move.to;
      return next;
    };
    const perspectiveStateForCpu = (state) => {
      if (state.mode !== "cpu") return state;
      const humanSide = other(state.cpuColor);
      if (state.secrets[humanSide].revealed) return state;
      const masked = cloneState(state);
      masked.secrets[humanSide] = { ...masked.secrets[humanSide], pieceId: "__hidden__" };
      return masked;
    };
    const legalMoves = (state, color) => {
      const allowSelf = !state.secrets[other(color)].revealed;
      const candidates = pseudoMoves(state, color, allowSelf, false);
      const legal = [];
      for (const move of candidates) {
        if (!move.to) continue;
        const piece = state.board[move.from];
        if (!piece) continue;
        const variants = maybePromotion(piece, move.to) ? PROMOTION_TYPES.map((promotion) => ({ ...move, promotion })) : [move];
        for (const variant of variants) {
          const next = simulateMoveNoFinalize({ ...state, turn: color }, variant);
          const kingSq = findKing(next.board, color);
          if (!kingSq) continue;
          if (!squareAttacked(next, kingSq, other(color))) legal.push(variant);
        }
      }
      if (!state.secrets[color].revealed && state.secrets[color].pieceId !== "__hidden__") legal.push({ from: "a1", kind: "reveal" });
      return legal;
    };
    const computeTerminalState = (state) => {
      const current = state.turn;
      const currentKing = findKing(state.board, current);
      const enemyKing = findKing(state.board, other(current));
      if (!currentKing) return { winner: other(current), result: other(current) + " wins", status: (state.status + " " + other(current) + " wins").trim() };
      if (!enemyKing) return { winner: current, result: current + " wins", status: (state.status + " " + current + " wins").trim() };
      const nextLegal = legalMoves({ ...state, selected: null }, current);
      const inCheck = squareAttacked(state, currentKing, other(current));
      if (nextLegal.length === 0) {
        if (inCheck) return { winner: other(current), result: other(current) + " wins by checkmate", status: (state.status + " Checkmate").trim() };
        return { winner: null, result: "Draw by stalemate", status: (state.status + " Stalemate").trim() };
      }
      return { winner: null, result: null, status: inCheck ? (state.status + " " + current + " is in check").trim() : state.status };
    };
    const finalizeState = (state) => {
      const terminal = computeTerminalState(state);
      return { ...state, winner: terminal.winner, result: terminal.result, status: terminal.status };
    };
    const applyMove = (state, move) => finalizeState(simulateMoveNoFinalize(state, move));
    const pieceValue = (type) => ({ K: 20000, Q: 900, R: 500, B: 330, N: 320, P: 100 }[type]);
    const evaluate = (state, forColor) => {
      if (state.result) {
        if (state.winner === forColor) return 999999;
        if (state.winner === other(forColor)) return -999999;
        return 0;
      }
      let score = 0;
      for (const sq of Object.keys(state.board)) {
        const p = state.board[sq];
        if (!p) continue;
        score += p.color === forColor ? pieceValue(p.type) : -pieceValue(p.type);
        const { f, r } = coords(sq);
        const center = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 4.5));
        score += (p.color === forColor ? 1 : -1) * center * 3;
        if (p.promotedFromPawn) score += p.color === forColor ? 30 : -30;
      }
      if (!state.secrets[forColor].revealed) score += 20;
      if (!state.secrets[other(forColor)].revealed) score -= 20;
      return score;
    };
    const moveHeuristic = (state, move, color) => {
      if (move.kind === "reveal") return 60;
      if (!move.to) return 0;
      const piece = state.board[move.from];
      const target = state.board[move.to];
      let score = 0;
      if (target) {
        score += 10 * pieceValue(target.type) - (piece ? pieceValue(piece.type) : 0);
      }
      if (!target && state.enPassantTarget === move.to) score += 120;
      if (move.promotion) score += pieceValue(move.promotion) + 200;
      return score;
    };
    const orderMoves = (state, moves, color) => [...moves].sort((a, b) => moveHeuristic(state, b, color) - moveHeuristic(state, a, color));
    const minimax = (state, depth, alpha, beta, maximizing, root) => {
      if (depth === 0 || state.result) return evaluate(state, root);
      const side = maximizing ? root : other(root);
      const viewedState = perspectiveStateForCpu({ ...state, turn: side });
      let moves = legalMoves(viewedState, side);
      if (!moves.length) return evaluate(finalizeState({ ...state, turn: side }), root);
      moves = orderMoves(viewedState, moves, side);
      if (maximizing) {
        let best = -Infinity;
        for (const move of moves) {
          const next = applyMove(viewedState, move);
          const score = minimax(next, depth - 1, alpha, beta, false, root);
          best = Math.max(best, score);
          alpha = Math.max(alpha, best);
          if (beta <= alpha) break;
        }
        return best;
      }
      let best = Infinity;
      for (const move of moves) {
        const next = applyMove(viewedState, move);
        const score = minimax(next, depth - 1, alpha, beta, true, root);
        best = Math.min(best, score);
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    };
    const pickCpuMove = (state) => {
      const color = state.cpuColor;
      const viewedState = perspectiveStateForCpu({ ...state, turn: color });
      let moves = legalMoves(viewedState, color);
      if (!moves.length) return finalizeState({ ...state, turn: color });
      moves = orderMoves(viewedState, moves, color);
      if (moves.length === 1) return applyMove(state, moves[0]);
      if (state.difficulty === "Easy") {
        const captures = moves.filter((m) => m.to && (state.board[m.to] || state.enPassantTarget === m.to));
        return applyMove(state, captures[0] || moves[0]);
      }
      const depth = state.difficulty === "Hard" ? 2 : 1;
      let best = -Infinity;
      let bestMove = moves[0];
      for (const move of moves) {
        const next = applyMove(state, move);
        const score = minimax(next, depth, -Infinity, Infinity, false, color);
        if (score > best) {
          best = score;
          bestMove = move;
        }
      }
      return applyMove(state, bestMove);
    };
    self.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== "pickMove") return;
      const nextState = pickCpuMove(data.state);
      self.postMessage({ type: "pickMoveResult", requestId: data.requestId, nextState });
    };
  `;

  const blob = new Blob([workerSource], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

function runSelfTests() {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Self-test failed: ${message}`);
  };

  assert(other("white") === "black" && other("black") === "white", "other() flips colors");
  assert(inBounds(0, 1) && inBounds(7, 8) && !inBounds(-1, 3) && !inBounds(8, 3), "inBounds works");

  const board = createInitialBoard();
  assert(Object.keys(board).length === 64, "board has 64 squares");
  assert(board["e1"]?.type === "K" && board["e8"]?.type === "K", "kings are placed correctly");

  const secrets = createSecrets(board);
  assert(!!secrets.white.pieceId && !!secrets.black.pieceId, "secrets are generated");
  assert(!!secrets.white.initialSquare && !!secrets.black.initialSquare, "secret initial squares are stored");
  assert(secrets.white.pieceId !== board["e1"]?.id, "white secret never points to a king");
  assert(secrets.black.pieceId !== board["e8"]?.id, "black secret never points to a king");
  assert(board[secrets.white.initialSquare]?.id === secrets.white.pieceId, "white secret initial square matches secret piece id");
  assert(board[secrets.black.initialSquare]?.id === secrets.black.pieceId, "black secret initial square matches secret piece id");
  assert(board[secrets.white.initialSquare]?.type !== "R", "white secret is never a rook");
  assert(board[secrets.black.initialSquare]?.type !== "R", "black secret is never a rook");

  const start = initialState();
  const whiteLegal = legalMoves(start, "white");
  assert(whiteLegal.length > 0, "white has legal moves from the initial position");
  assert(whiteLegal.some((m) => m.kind === "reveal"), "reveal is available initially");

  const revealed = applyMove(start, { from: "a1", kind: "reveal" });
  assert(revealed.turn === "black", "reveal consumes the turn");
  assert(revealed.secrets.white.revealed, "white secret becomes revealed");

  const promoBoard = {} as Record<Square, Piece | null>;
  for (const file of FILES) for (const rank of RANKS_ASC) promoBoard[`${file}${rank}` as Square] = null;
  promoBoard["e1"] = { id: "w-K-promo", type: "K", color: "white", moved: false };
  promoBoard["e8"] = { id: "b-K-promo", type: "K", color: "black", moved: false };
  promoBoard["a7"] = { id: "w-P-promo", type: "P", color: "white", moved: true };
  const promoState: State = {
    ...initialState(),
    board: promoBoard,
    turn: "white",
    selected: null,
    flipped: false,
    quietus: { white: [], black: [] },
    mode: "human",
    cpuColor: "black",
    difficulty: "Medium",
    status: "",
    winner: null,
    result: null,
    showRules: false,
    secrets: {
      white: { pieceId: "b-P-hidden", revealed: false, initialSquare: "a7" },
      black: { pieceId: "w-P-hidden", revealed: false, initialSquare: "a2" },
    },
    peek: "none",
    pendingPromotion: null,
    enPassantTarget: null,
    lastMove: null,
  };
  const promoMoves = legalMoves(promoState, "white").filter((m) => m.from === "a7" && m.to === "a8");
  assert(promoMoves.length === 4, "promotion generates four explicit variants");
  const pendingPromo = applyMove(promoState, humanMoveFromCandidates(promoMoves)!);
  assert(!!pendingPromo.pendingPromotion, "human promotion path opens chooser instead of auto-promoting");

  const cpuPeekState: State = { ...initialState(), mode: "cpu", cpuColor: "black" };
  const maskedCpuView = perspectiveStateForCpu(cpuPeekState);
  assert(maskedCpuView.secrets.white.pieceId === "__hidden__", "cpu view masks the human hidden fifth column");

  assert(canBePurgedTarget({ id: "x1", type: "P", color: "white", moved: false }), "pawn can be purged");
  assert(canBePurgedTarget({ id: "x2", type: "B", color: "white", moved: false }), "bishop can be purged");
  assert(canBePurgedTarget({ id: "x3", type: "N", color: "white", moved: false }), "knight can be purged");
  assert(!canBePurgedTarget({ id: "x4", type: "Q", color: "white", moved: false }), "queen cannot be purged");
  assert(!canBePurgedTarget({ id: "x5", type: "K", color: "white", moved: false }), "king cannot be purged");
  assert(!canBePurgedTarget({ id: "x6", type: "R", color: "white", moved: false }), "rook cannot be purged");
  assert(canBePurgedTarget({ id: "x7", type: "Q", color: "white", moved: true, promotedFromPawn: true }), "promoted pawn can be purged even after promotion");

  const promotedPurgeBoard = {} as Record<Square, Piece | null>;
  for (const file of FILES) {
    for (const rank of RANKS_ASC) {
      promotedPurgeBoard[`${file}${rank}` as Square] = null;
    }
  }
  promotedPurgeBoard["e1"] = { id: "w-K-promote", type: "K", color: "white", moved: false };
  promotedPurgeBoard["e8"] = { id: "b-K-promote", type: "K", color: "black", moved: false };
  promotedPurgeBoard["d1"] = { id: "w-R-base", type: "R", color: "white", moved: true };
  promotedPurgeBoard["d4"] = { id: "w-Q-promoted", type: "Q", color: "white", moved: true, promotedFromPawn: true };
  const promotedPurgeState: State = {
    ...initialState(),
    board: promotedPurgeBoard,
    turn: "white",
    selected: null,
    flipped: false,
    quietus: { white: [], black: [] },
    mode: "human",
    cpuColor: "black",
    difficulty: "Medium",
    status: "",
    winner: null,
    result: null,
    showRules: false,
    secrets: {
      white: { pieceId: "b-P-hidden", revealed: false, initialSquare: "a7" },
      black: { pieceId: "w-P-hidden", revealed: false, initialSquare: "a2" },
    },
    peek: "none",
    pendingPromotion: null,
    enPassantTarget: null,
    lastMove: null,
  };
  const promotedPurgeMoves = legalMoves(promotedPurgeState, "white");
  assert(
    promotedPurgeMoves.some((m) => m.kind === "selfCapture" && m.from === "d1" && m.to === "d4"),
    "legal self-capture is generated against a promoted pawn",
  );

  const captureBoard = {} as Record<Square, Piece | null>;
  for (const file of FILES) for (const rank of RANKS_ASC) captureBoard[`${file}${rank}` as Square] = null;
  captureBoard["e1"] = { id: "w-K-test", type: "K", color: "white", moved: false };
  captureBoard["e8"] = { id: "b-K-test", type: "K", color: "black", moved: false };
  captureBoard["d4"] = { id: "w-B-secret", type: "B", color: "black", moved: true };
  captureBoard["c3"] = { id: "b-N-captor", type: "N", color: "black", moved: true };
  const captureState: State = {
    ...initialState(),
    board: captureBoard,
    turn: "black",
    quietus: { white: [], black: [] },
    secrets: {
      white: { pieceId: "b-P-x", revealed: false, initialSquare: "a7" },
      black: { pieceId: "w-B-secret", revealed: true, initialSquare: "d4" },
    },
    peek: "none",
    pendingPromotion: null,
    enPassantTarget: null,
    winner: null,
    result: null,
    status: "",
    selected: null,
    showRules: false,
    mode: "human",
    cpuColor: "black",
    difficulty: "",
    lastMove: null,
    flipped: false,
  };
  const capturedFifthColumn = applyMove(captureState, { from: "c3", to: "d4", kind: "move" });
  assert(capturedFifthColumn.quietus.white.some((p) => p.id === "w-B-secret"), "captured fifth-column piece goes to quietus of its initial color");
}

function SquareView({
  sq,
  piece,
  selected,
  highlight,
  onClick,
  onDragStart,
  onDrop,
  onDragOver,
  pieceSize = "3.4rem",
  rotatePiece = false,
}: {
  sq: Square;
  piece: Piece | null;
  selected: boolean;
  highlight: "from" | "to" | "none";
  onClick: () => void;
  onDragStart: (e: React.DragEvent<HTMLButtonElement>, sq: Square) => void;
  onDrop: (e: React.DragEvent<HTMLButtonElement>, sq: Square) => void;
  onDragOver: (e: React.DragEvent<HTMLButtonElement>) => void;
  pieceSize?: string;
  rotatePiece?: boolean;
}) {
  const { f, r } = coords(sq);
  const isDark = (f + r) % 2 === 0;
  const border = selected
    ? "0 0 0 3px rgba(0,0,0,0.35) inset"
    : highlight === "from"
      ? "0 0 0 3px rgba(250,204,21,.75) inset"
      : highlight === "to"
        ? "0 0 0 3px rgba(74,222,128,.75) inset"
        : "none";

  const glyphSet = GLYPHS;

  return (
    <button
      onClick={onClick}
      draggable={!!piece}
      onDragStart={(e) => onDragStart(e, sq)}
      onDrop={(e) => onDrop(e, sq)}
      onDragOver={onDragOver}
      className="relative aspect-square flex items-center justify-center select-none"
      style={{
        background: isDark ? ACCENT : `linear-gradient(135deg, #ead8bb 0%, ${WOOD_LIGHT} 100%)`,
        boxShadow: border,
      }}
    >
      {piece && (
        <div
          style={{
            fontSize: pieceSize,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            transform: rotatePiece ? "translateY(-4%) rotate(180deg)" : "translateY(4%)",
            transformOrigin: "center",
            textShadow: piece.color === "white" ? "0 0 0.8px #000, 0 0 0.8px #000" : "none",
            WebkitTextStroke: piece.color === "white" ? "0.6px #000" : undefined,
            color: piece.color === "white" ? "#ffffff" : "#000000",
          }}
        >
          {glyphSet[piece.color][piece.type]}
        </div>
      )}
    </button>
  );
}

function CapturedRow({
  title,
  pieces,
  score,
  fifthColumnPieceIds,
  compact = false,
}: {
  title: string;
  pieces: Piece[];
  score: number;
  fifthColumnPieceIds: string[];
  compact?: boolean;
}) {
  const quietusColor: Color = title.includes("Black captured") ? "black" : "white";

  return (
    <div className={compact ? "rounded-2xl p-2 border" : "rounded-2xl p-3 border"} style={{ background: PANEL_2, borderColor: BORDER }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-sm font-semibold" style={{ color: TEXT }}>
          {score > 0 ? score : ""}
        </div>
      </div>
      <div className={compact ? "min-h-8 flex flex-wrap gap-1 text-2xl" : "min-h-12 flex flex-wrap gap-1 text-3xl"}>
        {pieces.length ? pieces.map((p, i) => {
          const isFifthColumn = fifthColumnPieceIds.includes(p.id);
          const displayColor: Color = isFifthColumn ? quietusColor : p.color;
          const dotStyle = quietusColor === "black"
            ? { background: "#ffffff", border: "1px solid #000000" }
            : { background: "#000000", border: "none" };

          return (
            <span
              key={`${p.id}-${i}`}
              className="relative inline-flex items-start justify-start"
              style={{
                fontSize: compact ? "1.32rem" : "2.2rem",
                lineHeight: 1,
                textShadow: displayColor === "white" ? "0 0 0.6px #000, 0 0 0.6px #000" : "none",
                WebkitTextStroke: displayColor === "white" ? "0.6px #000" : undefined,
                color: displayColor === "white" ? "#ffffff" : "#000000",
              }}
            >
              {GLYPHS[displayColor][p.type]}
              {isFifthColumn && (
                <span
                  style={{
                    position: "absolute",
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    top: "4px",
                    right: "2px",
                    ...dotStyle,
                  }}
                />
              )}
            </span>
          );
        }) : <span className="text-sm opacity-60">—</span>}
      </div>
    </div>
  );
}

function FloralTile() {
  return (
    <svg viewBox="0 0 96 96" className="w-9 h-9 opacity-90" aria-hidden="true">
      <g fill="none" stroke="rgba(244,241,236,0.94)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M48 80 C44 68, 46 58, 52 48 C60 38, 70 34, 80 30" />
        <path d="M48 80 C52 68, 50 58, 44 48 C36 38, 26 34, 16 30" />
        <path d="M45 49 C37 47, 31 44, 27 38 C34 35, 40 38, 45 44" fill="rgba(244,241,236,0.14)" />
        <path d="M51 49 C59 47, 65 44, 69 38 C62 35, 56 38, 51 44" fill="rgba(244,241,236,0.14)" />
        <path d="M47 36 C42 32, 39 27, 38 19 C44 20, 47 23, 49 29" fill="rgba(244,241,236,0.14)" />
        <path d="M49 36 C54 32, 57 27, 58 19 C52 20, 49 23, 47 29" fill="rgba(244,241,236,0.14)" />
        <path d="M42 61 C37 63, 32 68, 29 75 C36 75, 40 71, 44 66" fill="rgba(244,241,236,0.14)" />
        <path d="M54 61 C59 63, 64 68, 67 75 C60 75, 56 71, 52 66" fill="rgba(244,241,236,0.14)" />
        <path d="M44 72 L48 66 L52 72" />
        <path d="M48 80 C46 85, 43 88, 39 90" />
      </g>
    </svg>
  );
}

function FifthColumnCard({
  revealed,
  info,
  onToggle,
  onHide,
  canReveal,
  isSecretRevealed,
  onReveal,
  compact,
}: {
  revealed: boolean;
  info: {
    secret: SecretInfo;
    piece: Piece | null;
    originalPiece: Piece | null;
  } | null;
  onToggle: () => void;
  onHide: () => void;
  canReveal: boolean;
  isSecretRevealed: boolean;
  onReveal: () => void;
  compact?: boolean;
}) {
  const displayPiece = info?.piece || info?.originalPiece || null;

  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        onMouseLeave={() => {
          if (revealed) onHide();
        }}
        className={`${compact ? "w-[104px] h-[150px]" : "w-[170px] h-[250px]"} rounded-[18px] border overflow-hidden transition-transform duration-150 hover:scale-[1.02] shadow-lg`}
        style={{ background: PANEL_2, borderColor: BORDER, color: TEXT }}
      >
        {!revealed && (
          <div className="relative h-full p-3" style={{ background: ACCENT }}>
            <div className="absolute inset-[10px] rounded-[14px] border-2" style={{ borderColor: "rgba(244,241,236,0.72)" }} />
            <div className="absolute inset-[20px] rounded-[10px] border" style={{ borderColor: "rgba(244,241,236,0.45)" }} />
            <div className="absolute inset-[22px] rounded-[10px] overflow-hidden">
              <div className="grid grid-cols-4 grid-rows-5 place-items-center h-full bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(0,0,0,0.05))]">
                {Array.from({ length: 20 }).map((_, idx) => (
                  <FloralTile key={idx} />
                ))}
              </div>
            </div>
          </div>
        )}

        {revealed && info && (
          <div className={`${compact ? "p-2" : "p-4"} h-full flex flex-col items-center justify-center text-center`} style={{ background: "#ffffff" }}>
            <div className="text-[10px] font-normal uppercase tracking-[0.12em]" style={{ color: "#000000", opacity: 0.8 }}>
              {isSecretRevealed ? (info.piece ? "Revealed" : "Captured") : "Hidden"}
            </div>
            <div className="mt-2 flex-1 flex items-center justify-center min-h-0">
              {displayPiece ? (
                <div
                  style={{
                    fontSize: compact ? "3.2rem" : "5.2rem",
                    fontFamily: "Segoe UI Symbol, Noto Sans Symbols, serif",
                    lineHeight: 1,
                    textShadow: displayPiece.color === "white" ? "0 0 1px #000, 0 0 1px #000" : "none",
                    WebkitTextStroke: displayPiece.color === "white" ? "1px #000" : undefined,
                    color: displayPiece.color === "white" ? "#ffffff" : "#000000",
                    opacity: info.piece ? 1 : 0.5,
                  }}
                >
                  {GLYPHS[displayPiece.color][displayPiece.type]}
                </div>
              ) : (
                <div className="text-xs opacity-70 px-2">Unknown</div>
              )}
            </div>
            <div className={`${compact ? "text-[11px]" : "text-sm"} font-semibold`}>{info.secret.initialSquare}</div>
            {!isSecretRevealed && canReveal && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReveal();
                  }}
                  className={`${compact ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-xs"} rounded-xl cursor-pointer`}
                  style={{ background: "#ffffff", color: "#000000", border: "1px solid #000000" }}
                >
                  Reveal fifth column
                </button>
              </div>
            )}
          </div>
        )}
      </button>
    </div>
  );
}

type DropdownOption<T extends string> = {
  value: T;
  label: string;
};

function CustomDropdown<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  widthLabels,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
  widthLabels?: string[];
}) {
  const [open, setOpen] = useState(false);
  const idRef = useRef(Math.random().toString(36));
  const selected = options.find((option) => option.value === value) || options[0];
  const widthSourceLabels = widthLabels?.length ? widthLabels : options.map((option) => option.label);
  const longestLabel = widthSourceLabels.reduce((longest, label) => label.length > longest.length ? label : longest, "");
  const dropdownWidth = `calc(${longestLabel.length}ch + 2.8rem)`;
  const SELECT_GRAY = "#c8bcae";
  const SELECT_GRAY_HOVER = "#d7cdc0";

  useEffect(() => {
    function handleGlobal(e: any) {
      if (e.detail !== idRef.current) {
        setOpen(false);
      }
    }
    window.addEventListener("dropdown-open", handleGlobal);
    return () => window.removeEventListener("dropdown-open", handleGlobal);
  }, []);

  useEffect(() => {
    if (!open) return;
    function close() {
      setOpen(false);
    }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative inline-block shrink-0" style={{ width: dropdownWidth }}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) {
            const next = !open;
            setOpen(next);
            if (next) {
              window.dispatchEvent(new CustomEvent("dropdown-open", { detail: idRef.current }));
            }
          }
        }}
        className={`w-full rounded-2xl px-3 ${compact ? "py-1.5 text-[13px] h-9" : "py-2 text-sm"} flex items-center justify-between gap-3 disabled:opacity-50 disabled:cursor-not-allowed`}
        style={{
          background: disabled ? "#ede7df" : "#ede7df",
          border: `1px solid ${BORDER}`,
          color: disabled ? "#7a6f63" : TEXT,
          outline: "none",
          boxShadow: "none",
        }}
      >
        <span className="whitespace-nowrap">{selected?.label}</span>
        <span style={{ fontSize: "10px", opacity: 0.65, transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>

      {open && !disabled && (
        <div
          className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-2xl shadow-lg"
          style={{ background: "#ede7df", border: `1px solid ${BORDER}`, color: TEXT }}
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={`w-full px-3 ${compact ? "py-1.5 text-[13px]" : "py-2 text-sm"} text-left transition-colors whitespace-nowrap`}
                style={{
                  background: active ? SELECT_GRAY : PANEL_2,
                  color: TEXT,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = active ? SELECT_GRAY : SELECT_GRAY_HOVER;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = active ? SELECT_GRAY : PANEL_2;
                }}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  useEffect(() => {
    function handleGlobalClick() {
      setState((s) => (s.peek !== "none" ? { ...s, peek: "none" } : s));
    }

    document.addEventListener("click", handleGlobalClick);
    return () => document.removeEventListener("click", handleGlobalClick);
  }, []);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
  const [state, setState] = useState<State>(initialState);
  const [purgeChoice, setPurgeChoice] = useState<{ from: Square; to: Square; move: Move } | null>(null);
  const [peekConfirm, setPeekConfirm] = useState<Color | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestIdRef = useRef(0);

  useEffect(() => {
    runSelfTests();
  }, []);

  useEffect(() => {
    const worker = createCpuWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data || data.type !== "pickMoveResult") return;
      if (data.requestId !== pendingRequestIdRef.current) return;
      setState((current) => {
        if (current.mode !== "cpu" || current.turn !== current.cpuColor || current.pendingPromotion || current.winner || current.result?.startsWith("Draw")) {
          return current;
        }
        return data.nextState;
      });
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const boardOrderRanks = state.flipped ? [...RANKS_ASC] : RANKS_DESC;
  const boardOrderFiles = state.flipped ? [...FILES].reverse() : FILES;
  const bottomColor: Color = state.flipped ? "black" : "white";
  function toggleFlip() {
    setState((s) => ({ ...s, flipped: !s.flipped }));
  }
  function setBottomColor(color: Color) {
    setState((s) => ({ ...s, flipped: color === "black" }));
  }
  const canReveal = !state.winner && !state.pendingPromotion && !state.secrets[state.turn].revealed;
  const humanSide: Color = state.mode === "cpu" ? other(state.cpuColor) : (state.flipped ? "black" : "white");
  const peekSide: Color = humanSide;

  const visibleIntel = useMemo(() => {
    if (state.peek === "none") return null;
    const secret = state.secrets[state.peek];
    const currentSquare = (Object.keys(state.board) as Square[]).find((sq) => state.board[sq]?.id === secret.pieceId) || null;
    const piece = currentSquare ? state.board[currentSquare] : null;
    const originalPiece = piece || { id: secret.pieceId, type: secret.pieceId.split("-")[1] as PieceType, color: state.peek, moved: true };
    return { viewer: state.peek, target: other(state.peek), secret, currentSquare, piece, originalPiece };
  }, [state.peek, state.secrets, state.board]);

  useEffect(() => {
    if (state.winner || state.result?.startsWith("Draw") || state.pendingPromotion) return;
    if (state.mode !== "cpu" || state.turn !== state.cpuColor) return;
    if (!workerRef.current) return;

    const requestId = ++pendingRequestIdRef.current;
    const snapshot = cloneState(state);
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({
        type: "pickMove",
        requestId,
        state: snapshot,
      } satisfies WorkerRequest);
    }, 10);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state.turn, state.mode, state.cpuColor, state.difficulty, state.pendingPromotion, state.winner, state.result, state.board, state.secrets, state.enPassantTarget, state.quietus]);

  function reset() {
    pendingRequestIdRef.current += 1;
    setPurgeChoice(null);
    setPeekConfirm(null);
    setState(initialState());
  }

  function handleClick(sq: Square) {
    if (state.winner || state.pendingPromotion || purgeChoice) return;
    if (state.mode === "cpu" && state.turn === state.cpuColor) return;

    if (!state.selected) {
      if (state.board[sq]?.color === state.turn) {
        const piece = state.board[sq];
        setState((s) => ({
          ...s,
          selected: sq,
          status: piece ? `Selected: ${pieceName(piece.type)} on ${sq}` : s.status,
        }));
      }
      return;
    }

    if (state.selected === sq) {
      setState((s) => ({ ...s, selected: null }));
      return;
    }

    const moves = legalMoves(state, state.turn).filter(
      (m) => m.kind !== "reveal" && m.from === state.selected && m.to === sq,
    );
    const purgeMove = moves.find((m) => m.kind === "selfCapture");
    const normalMove = humanMoveFromCandidates(moves.filter((m) => m.kind !== "selfCapture"));

    if (purgeMove && state.board[sq]?.color === state.turn) {
      setPurgeChoice({ from: state.selected, to: sq, move: purgeMove });
      return;
    }

    if (normalMove) {
      pendingRequestIdRef.current += 1;
      setState((s) => applyMove(s, normalMove));
      return;
    }

    if (state.board[sq]?.color === state.turn) {
      const target = state.board[sq];
      const purgeNotAllowed = state.secrets[other(state.turn)].revealed;
      const validTarget = canBePurgedTarget(target);

      if (purgeNotAllowed && validTarget) {
        setState((s) => ({
          ...s,
          selected: sq,
          status: "Purging already not allowed: opponent's 'fifth column' has already been revealed",
        }));
        return;
      }

      setState((s) => ({
        ...s,
        selected: sq,
        status: s.board[sq] ? `Selected: ${pieceName(s.board[sq]!.type)} on ${sq}` : s.status,
      }));
      return;
    }
  }

  function handleDragStart(e: React.DragEvent<HTMLButtonElement>, sq: Square) {
    if (state.winner || state.pendingPromotion || (state.mode === "cpu" && state.turn === state.cpuColor)) {
      e.preventDefault();
      return;
    }
    if (!state.board[sq] || state.board[sq]?.color !== state.turn) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/plain", sq);
    e.dataTransfer.effectAllowed = "move";
    setState((s) => ({
          ...s,
          selected: sq,
          status: s.board[sq] ? `Selected: ${pieceName(s.board[sq]!.type)} on ${sq}` : s.status,
        }));
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>, sq: Square) {
    e.preventDefault();
    if (state.winner || state.pendingPromotion || purgeChoice || (state.mode === "cpu" && state.turn === state.cpuColor)) return;

    const from = e.dataTransfer.getData("text/plain") as Square;
    if (!from) return;

    const moves = legalMoves(state, state.turn).filter(
      (m) => m.kind !== "reveal" && m.from === from && m.to === sq,
    );

    if (!moves.length) {
      if (state.board[sq]?.color === state.turn) {
        const target = state.board[sq];
        const purgeNotAllowed = state.secrets[other(state.turn)].revealed;
        const invalidTarget = !canBePurgedTarget(target);

        if (purgeNotAllowed && invalidTarget) {
          setState((s) => ({
            ...s,
            selected: sq,
            status: "Purging already not allowed, plus that only pawns, bishops, knights, or promoted pawns can be purged",
          }));
          return;
        }

        if (invalidTarget) {
          setState((s) => ({
            ...s,
            selected: sq,
            status: "Purging not allowed: only pawns, bishops, knights, or promoted pawns can be purged",
          }));
          return;
        }

        if (purgeNotAllowed) {
          setState((s) => ({
            ...s,
            selected: sq,
            status: "Purging already not allowed: opponent's 'fifth column' has already been revealed",
          }));
          return;
        }

        setState((s) => ({
          ...s,
          selected: sq,
          status: s.board[sq] ? `Selected: ${pieceName(s.board[sq]!.type)} on ${sq}` : s.status,
        }));
      }
      return;
    }

    const purgeMove = moves.find((m) => m.kind === "selfCapture");
    if (purgeMove && state.board[sq]?.color === state.turn) {
      pendingRequestIdRef.current += 1;
      setState((s) => applyMove(s, purgeMove));
      return;
    }

    const chosenMove = humanMoveFromCandidates(moves);
    if (!chosenMove) return;

    pendingRequestIdRef.current += 1;
    setState((s) => applyMove(s, chosenMove));
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
  }

  function handleReveal() {
    if (!canReveal || purgeChoice) return;
    if (state.mode === "cpu" && state.turn === state.cpuColor) return;
    pendingRequestIdRef.current += 1;
    setState((s) => applyMove(s, { from: "a1", kind: "reveal" }));
  }

  function handlePromotion(type: Exclude<PieceType, "K" | "P">) {
    if (!state.pendingPromotion || purgeChoice) return;
    pendingRequestIdRef.current += 1;
    setState((current) => {
      if (!current.pendingPromotion) return current;

      const next = cloneState(current);
      const square = next.pendingPromotion.square;
      const piece = next.board[square];
      if (!piece) return { ...next, pendingPromotion: null };

      next.board[square] = {
        ...piece,
        type,
        promotedFromPawn: true,
        moved: true,
      };
      next.pendingPromotion = null;
      next.turn = other(current.turn);
      next.status = `${current.turn} promoted on ${square}`;
      return finalizeState(next);
    });
  }

  const thinking = state.mode === "cpu" && state.turn === state.cpuColor && !state.pendingPromotion && !state.winner && !purgeChoice;

  const valueMap: Record<PieceType, number> = { K: 0, Q: 9, R: 5, B: 3, N: 3, P: 1 };
  const whiteTotal = state.quietus.white.reduce((s, p) => s + valueMap[p.type], 0);
  const blackTotal = state.quietus.black.reduce((s, p) => s + valueMap[p.type], 0);
  const diff = whiteTotal - blackTotal;
  const whiteScore = diff > 0 ? diff : 0;
  const blackScore = diff < 0 ? -diff : 0;

  return (
    <div className="min-h-screen text-[#0f172a]" style={{ background: PAGE_BG }}>
      <div className="max-w-7xl mx-auto p-3 md:p-6">
        <div className="xl:hidden space-y-3">
          <div className="rounded-3xl p-3" style={{ background: PANEL }}>
            <div className="flex items-center justify-between gap-3">
              <img
                src={LOGO_SRC}
                alt="Paranoia Chess logo"
                className={thinking ? "w-11 h-11 object-contain animate-pulse shrink-0" : "w-11 h-11 object-contain shrink-0"}
              />
              <div className="grid grid-cols-3 gap-2 flex-1">
                <button onClick={reset} className="px-3 py-2 rounded-2xl font-semibold text-sm" style={{ background: "#ffffff", color: TEXT }}>
                  New
                </button>
                <button onClick={toggleFlip} className="px-3 py-2 rounded-2xl font-semibold text-sm" style={{ background: PANEL_2, color: TEXT }}>
                  Flip
                </button>
                <button onClick={() => setState((s) => ({ ...s, showRules: true }))} className="px-3 py-2 rounded-2xl font-semibold text-sm" style={{ background: ACCENT, color: "#ffffff" }}>
                  Info
                </button>
              </div>
            </div>
          </div>

          <div
            className="px-1 text-sm leading-none min-h-[10px] flex items-center justify-between"
            style={{
              color: TEXT,
              marginTop: "-3px",
              marginBottom: isAndroid ? "-3px" : "6px",
            }}
          >
            <div style={{ textAlign: "left" }}>
              {state.result
                ? state.result
                : (state.status && state.status !== "White to move")
                  ? state.status
                  : "Paranoia Chess"}
            </div>

            {thinking && (
              <div
                style={{
                  color: ACCENT,
                  fontSize: "9px",
                  letterSpacing: "0.08em",
                  opacity: 0.9,
                  whiteSpace: "nowrap",
                }}
              >
                thinking...
              </div>
            )}
          </div>

          <div className="rounded-[28px] p-2 border shadow-xl mx-auto w-full max-w-[min(100vw-24px,560px)]" style={{ background: PANEL, borderColor: BORDER }}>
            <div className="grid grid-cols-[18px_1fr] grid-rows-[1fr_18px] gap-x-1 gap-y-1 items-stretch">
              <div className="grid grid-rows-8">
                {boardOrderRanks.map((rank) => (
                  <div key={`m-rank-${rank}`} className="flex items-center justify-center text-[10px] select-none" style={{ color: ACCENT }}>
                    {rank}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-8 overflow-hidden rounded-2xl w-full">
                {boardOrderRanks.map((rank) =>
                  boardOrderFiles.map((file) => {
                    const sq = `${file}${rank}` as Square;
                    const lm = state.lastMove;
                    const highlight: "from" | "to" | "none" = lm?.from === sq ? "from" : lm?.to === sq ? "to" : "none";
                    return (
                      <SquareView
                        key={`mobile-${sq}`}
                        sq={sq}
                        piece={state.board[sq]}
                        selected={state.selected === sq}
                        highlight={highlight}
                        onClick={() => handleClick(sq)}
                        onDragStart={handleDragStart}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        pieceSize="2.1rem"
                        rotatePiece={state.mode === "human" && !!state.board[sq] && state.board[sq]?.color === other(bottomColor)}
                      />
                    );
                  }),
                )}
              </div>

              <div />

              <div className="grid grid-cols-8">
                {boardOrderFiles.map((file) => (
                  <div key={`m-file-${file}`} className="flex items-center justify-center text-[10px] lowercase select-none" style={{ color: ACCENT }}>
                    {file}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-3xl p-2 border space-y-1.5" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="text-base font-semibold">Mode</div>
              <label className="flex flex-col gap-0.5 text-[13px]">
                <CustomDropdown<Mode>
                  compact
                  value={state.mode}
                  widthLabels={["With Human", "With Computer"]}
                  options={[
                    { value: "human", label: "With Human" },
                    { value: "cpu", label: "With Computer" },
                  ]}
                  onChange={(mode) => setState((s) => ({ ...s, mode }))}
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[13px]">
                <span>{state.mode === "human" ? "Bottom color" : "Computer plays"}</span>
                <CustomDropdown<Color>
                  compact
                  value={state.mode === "human" ? bottomColor : state.cpuColor}
                  widthLabels={["White", "Black"]}
                  options={[
                    { value: "white", label: "White" },
                    { value: "black", label: "Black" },
                  ]}
                  onChange={(color) => {
                    if (state.mode === "human") setBottomColor(color);
                    else setState((s) => ({ ...s, cpuColor: color }));
                  }}
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[13px]">
                <span>Level</span>
                <CustomDropdown<string>
                  compact
                  disabled={state.mode === "human"}
                  value={state.mode === "human" ? "Human" : state.difficulty}
                  widthLabels={["Human", "Easy", "Medium", "Hard"]}
                  options={state.mode === "human"
                    ? [{ value: "Human", label: "Human" }]
                    : [
                        { value: "Easy", label: "Easy" },
                        { value: "Medium", label: "Medium" },
                        { value: "Hard", label: "Hard" },
                      ]}
                  onChange={(difficulty) => setState((s) => ({ ...s, difficulty: difficulty as Difficulty }))}
                />
              </label>
            </div>

            <div className="rounded-3xl p-3 border space-y-3" style={{ background: PANEL, borderColor: BORDER }}>
              <div
                className="text-base font-semibold"
                style={{ transform: state.mode === "human" && state.turn === other(bottomColor) ? "rotate(180deg)" : "none" }}
              >Fifth column</div>
              {state.mode === "human" ? (
                <div className="flex justify-center gap-2">
                  {([state.turn] as Color[]).map((side) => {
                    const sideSecret = state.secrets[side];
                    const currentSquare = (Object.keys(state.board) as Square[]).find((sq) => state.board[sq]?.id === sideSecret.pieceId) || null;
                    const sidePiece = currentSquare ? state.board[currentSquare] : null;
                    const originalPiece = sidePiece || {
                      id: sideSecret.pieceId,
                      type: sideSecret.pieceId.split("-")[1] as PieceType,
                      color: side,
                      moved: true,
                    };

                    return (
                      <div
                        key={`mobile-wrap-${side}`}
                        className="flex flex-col items-center gap-1"
                        style={{ transform: side === other(bottomColor) ? "rotate(180deg)" : "none" }}
                      >
                        <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: "#000", opacity: 0.7 }}>{side}</div>
                        <FifthColumnCard
                          revealed={state.peek === side}
                          info={{ secret: sideSecret, piece: sidePiece, originalPiece }}
                          onToggle={() => {
                            if (state.peek === side) setState((s) => ({ ...s, peek: "none" }));
                            else setPeekConfirm(side);
                          }}
                          onHide={() => setState((s) => ({ ...s, peek: "none" }))}
                          canReveal={!state.winner && !state.pendingPromotion && !sideSecret.revealed && state.turn === side}
                          isSecretRevealed={sideSecret.revealed}
                          onReveal={() => {
                            if (state.turn === side) handleReveal();
                          }}
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <FifthColumnCard
                  revealed={state.peek === peekSide}
                  info={visibleIntel ? { secret: visibleIntel.secret, piece: visibleIntel.piece, originalPiece: visibleIntel.originalPiece } : null}
                  onToggle={() => setState((s) => ({ ...s, peek: s.peek === peekSide ? "none" : peekSide }))}
                  onHide={() => setState((s) => ({ ...s, peek: "none" }))}
                  canReveal={canReveal}
                  isSecretRevealed={state.secrets[peekSide].revealed}
                  onReveal={handleReveal}
                  compact
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <CapturedRow
              compact
              title="Quietus · Black captured pieces"
              pieces={state.quietus.black}
              score={blackScore}
              fifthColumnPieceIds={[
                state.secrets.white.revealed ? state.secrets.white.pieceId : "",
                state.secrets.black.revealed ? state.secrets.black.pieceId : "",
              ].filter(Boolean)}
            />
            <CapturedRow
              compact
              title="Quietus · White captured pieces"
              pieces={state.quietus.white}
              score={whiteScore}
              fifthColumnPieceIds={[
                state.secrets.white.revealed ? state.secrets.white.pieceId : "",
                state.secrets.black.revealed ? state.secrets.black.pieceId : "",
              ].filter(Boolean)}
            />
          </div>

          <details className="rounded-3xl p-3 border" style={{ background: PANEL, borderColor: BORDER }}>
            <summary className="cursor-pointer text-base font-semibold" style={{ color: TEXT }}>Variant summary</summary>
            <div className="text-sm space-y-2 opacity-90 mt-3">
              <p>Each player secretly owns one 'fifth column' piece - a pawn, bishop, or knight on the opponent's side.</p>
              <p>On your turn, you may reveal that piece instead of moving. It flips color and joins your side.</p>
              <p>Before the fifth column in one's side is revealed, the player may purge their own pawns, bishops, and knights in an episode of paranoia.</p>
              <p>All the rest is like the classical chess.</p>
            </div>
          </details>

          <div style={{ marginTop: "12px" }}>
            <div style={{ fontSize: "13px", letterSpacing: "0.06em", marginBottom: "4px", color: ACCENT, fontWeight: 500 }}>
              Other Yanevi's Variants
            </div>
            <a
              href="https://www.kafkachess.com"
              target="_blank"
              rel="noopener noreferrer"
              title="Other Yanevi's Variants"
              className="flex items-center gap-3 px-2 py-2 rounded-xl transition-colors duration-200 hover:bg-[rgba(176,122,82,0.12)]"
              style={{ color: TEXT, textDecoration: "none" }}
            >
              <img
                src="/cover-bmac.png"
                alt="Kafka Chess"
                style={{ width: "28px", height: "28px", objectFit: "contain" }}
              />
              <span style={{ fontSize: "11.5px", opacity: 0.85 }}>
                Kafka Chess (pieces transform based on the square they step on)
              </span>
            </a>
          </div>
        </div>

        <div className="hidden xl:grid grid-cols-[280px_minmax(520px,1fr)_280px] gap-4">
          <div className="space-y-4">
            <div className="rounded-3xl p-4 border" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="flex items-center gap-3 mb-3">
                <img
                  src={LOGO_SRC}
                  alt="Paranoia Chess logo"
                  className={thinking ? "w-14 h-14 object-contain animate-pulse" : "w-14 h-14 object-contain"}
                />
                <div className="text-xl font-semibold">Paranoia Chess</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={reset} className="px-4 py-2 rounded-2xl font-semibold" style={{ background: "#ffffff", color: TEXT }}>
                  New
                </button>
                <button onClick={toggleFlip} className="px-4 py-2 rounded-2xl font-semibold" style={{ background: PANEL_2, color: TEXT }}>
                  Flip
                </button>
              </div>
              <div className="mt-4 text-sm opacity-80">
                Turn: <span className="font-semibold capitalize" style={{ color: "#000000" }}>{state.turn}</span>
              </div>
              <div className="mt-2 min-h-16 rounded-2xl p-3 text-sm border" style={{ background: "#ede7df", borderColor: BORDER, color: TEXT }}>
                {state.result || state.status}
              </div>
              <div className="mt-3">
                <button onClick={() => setState((s) => ({ ...s, showRules: true }))} className="px-4 py-2 rounded-2xl font-semibold" style={{ background: ACCENT, color: "#ffffff" }}>
                  Rules & Info
                </button>
              </div>
            </div>

            <div className="rounded-3xl p-4 border space-y-3" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="text-lg font-semibold">Computer opponent</div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Mode</span>
                <CustomDropdown<Mode>
                  value={state.mode}
                  widthLabels={["Human vs Human", "Human vs Computer"]}
                  options={[
                    { value: "human", label: "Human vs Human" },
                    { value: "cpu", label: "Human vs Computer" },
                  ]}
                  onChange={(mode) => setState((s) => ({ ...s, mode }))}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{state.mode === "human" ? "Bottom color" : "Computer plays"}</span>
                <CustomDropdown<Color>
                  value={state.mode === "human" ? bottomColor : state.cpuColor}
                  widthLabels={["White", "Black"]}
                  options={[
                    { value: "white", label: "White" },
                    { value: "black", label: "Black" },
                  ]}
                  onChange={(color) => {
                    if (state.mode === "human") setBottomColor(color);
                    else setState((s) => ({ ...s, cpuColor: color }));
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Level</span>
                <CustomDropdown<string>
                  disabled={state.mode === "human"}
                  value={state.mode === "human" ? "Human" : state.difficulty}
                  widthLabels={["Human", "Easy", "Medium", "Hard"]}
                  options={state.mode === "human"
                    ? [{ value: "Human", label: "Human" }]
                    : [
                        { value: "Easy", label: "Easy" },
                        { value: "Medium", label: "Medium" },
                        { value: "Hard", label: "Hard" },
                      ]}
                  onChange={(difficulty) => setState((s) => ({ ...s, difficulty: difficulty as Difficulty }))}
                />
              </label>
              {thinking && (
                <div className="text-xs" style={{ color: ACCENT, letterSpacing: "0.22em" }}>
                  t h i n k i n g ...
                </div>
              )}
            </div>

            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "14px", letterSpacing: "0.06em", marginBottom: "4px", color: ACCENT, fontWeight: 500 }}>
                Other Yanevi's Variants
              </div>
              <a
                href="https://www.kafkachess.com"
                target="_blank"
                rel="noopener noreferrer"
                title="Other Yanevi's Variants"
                className="flex items-center gap-3 px-2 py-2 rounded-xl transition-colors duration-200 hover:bg-[rgba(176,122,82,0.12)]"
                style={{ color: TEXT, textDecoration: "none" }}
              >
                <img
                  src="/cover-bmac.png"
                  alt="Kafka Chess"
                  style={{ width: "32px", height: "32px", objectFit: "contain" }}
                />
                <span style={{ fontSize: "12.5px", opacity: 0.85 }}>
                  Kafka Chess (pieces transform based on the square they step on)
                </span>
              </a>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-[28px] p-3 md:p-4 border shadow-2xl" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="grid grid-cols-[auto_1fr] grid-rows-[1fr_auto] gap-x-2 gap-y-2 items-stretch">
                <div className="grid grid-rows-8">
                  {boardOrderRanks.map((rank) => (
                    <div key={`rank-${rank}`} className="flex items-center justify-center text-sm select-none" style={{ color: ACCENT }}>
                      {rank}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-8 overflow-hidden rounded-2xl">
                  {boardOrderRanks.map((rank) =>
                    boardOrderFiles.map((file) => {
                      const sq = `${file}${rank}` as Square;
                      const lm = state.lastMove;
                      const highlight: "from" | "to" | "none" = lm?.from === sq ? "from" : lm?.to === sq ? "to" : "none";
                      return (
                        <SquareView
                          key={sq}
                          sq={sq}
                          piece={state.board[sq]}
                          selected={state.selected === sq}
                          highlight={highlight}
                          onClick={() => handleClick(sq)}
                          onDragStart={handleDragStart}
                          onDrop={handleDrop}
                          onDragOver={handleDragOver}
                          pieceSize="3.4rem"
                        />
                      );
                    }),
                  )}
                </div>

                <div />

                <div className="grid grid-cols-8">
                  {boardOrderFiles.map((file) => (
                    <div key={`file-${file}`} className="flex items-center justify-center pt-1 text-sm lowercase select-none" style={{ color: ACCENT }}>
                      {file}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CapturedRow
                title="Quietus · Black captured pieces"
                pieces={state.quietus.black}
                score={blackScore}
                fifthColumnPieceIds={[
                  state.secrets.white.revealed ? state.secrets.white.pieceId : "",
                  state.secrets.black.revealed ? state.secrets.black.pieceId : "",
                ].filter(Boolean)}
              />
              <CapturedRow
                title="Quietus · White captured pieces"
                pieces={state.quietus.white}
                score={whiteScore}
                fifthColumnPieceIds={[
                  state.secrets.white.revealed ? state.secrets.white.pieceId : "",
                  state.secrets.black.revealed ? state.secrets.black.pieceId : "",
                ].filter(Boolean)}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-3xl p-4 border space-y-3" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="text-lg font-semibold">Fifth column</div>
              {state.mode === "human" ? (
                <div className="flex justify-center gap-3 px-3 py-1">
                  {([state.turn] as Color[]).map((side) => {
                    const sideSecret = state.secrets[side];
                    const currentSquare = (Object.keys(state.board) as Square[]).find((sq) => state.board[sq]?.id === sideSecret.pieceId) || null;
                    const sidePiece = currentSquare ? state.board[currentSquare] : null;
                    const originalPiece = sidePiece || {
                      id: sideSecret.pieceId,
                      type: sideSecret.pieceId.split("-")[1] as PieceType,
                      color: side,
                      moved: true,
                    };

                    return (
                      <div key={`wrap-${side}`} className="flex flex-col items-center gap-2">
                        <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "#000", opacity: 0.7 }}>
                          {side}
                        </div>
                        <FifthColumnCard
                          revealed={state.peek === side}
                          info={{ secret: sideSecret, piece: sidePiece, originalPiece }}
                          onToggle={() => {
                            if (state.peek === side) setState((s) => ({ ...s, peek: "none" }));
                            else setPeekConfirm(side);
                          }}
                          onHide={() => setState((s) => ({ ...s, peek: "none" }))}
                          canReveal={!state.winner && !state.pendingPromotion && !sideSecret.revealed && state.turn === side}
                          isSecretRevealed={sideSecret.revealed}
                          onReveal={() => {
                            if (state.turn === side) handleReveal();
                          }}
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <FifthColumnCard
                  revealed={state.peek === peekSide}
                  info={visibleIntel ? { secret: visibleIntel.secret, piece: visibleIntel.piece, originalPiece: visibleIntel.originalPiece } : null}
                  onToggle={() => setState((s) => ({ ...s, peek: s.peek === peekSide ? "none" : peekSide }))}
                  onHide={() => setState((s) => ({ ...s, peek: "none" }))}
                  canReveal={canReveal}
                  isSecretRevealed={state.secrets[peekSide].revealed}
                  onReveal={handleReveal}
                />
              )}
            </div>

            <div className="rounded-3xl p-4 border" style={{ background: PANEL, borderColor: BORDER }}>
              <div className="text-lg font-semibold mb-3">Variant summary</div>
              <div className="text-sm space-y-2 opacity-90">
                <p>Each player secretly owns one 'fifth column' piece - a pawn, bishop, or knight on the opponent's side.</p>
                <p>On your turn, you may reveal that piece instead of moving. It flips color and joins your side.</p>
                <p>Before the fifth column in one's side is revealed, the player may purge their own pawns, bishops, and knights in an episode of paranoia.</p>
                <p>All the rest is like the classical chess.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      {peekConfirm && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-2 z-50" onClick={() => setPeekConfirm(null)}>
          <div
            className="w-full max-w-[340px] rounded-[24px] p-4 shadow-lg"
            style={{
              background: "#ffffff",
              border: `1px solid #000000`,
              boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
              color: TEXT,
              transform: isMobile && state.mode === "human" && peekConfirm === other(bottomColor) ? "rotate(180deg)" : "none",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] text-center mb-5" style={{ fontWeight: 400, letterSpacing: "0.03em" }}>
              Before seeing who is your fifth column, make sure that your opponent is not watching
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const side = peekConfirm;
                  if (side) setState((s) => ({ ...s, peek: side }));
                  setPeekConfirm(null);
                }}
                className="flex-1 py-3 rounded-2xl text-[13px] transition-all duration-150 hover:opacity-80 hover:-translate-y-[1px]"
                style={{ background: "transparent", color: ACCENT, border: `1px solid ${ACCENT}`, fontWeight: 500 }}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPeekConfirm(null);
                }}
                className="flex-1 py-3 rounded-2xl text-[13px] transition-all duration-150 hover:opacity-80 hover:-translate-y-[1px]"
                style={{ background: "transparent", color: TEXT, border: `1px solid ${BORDER}`, fontWeight: 400 }}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {purgeChoice && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-2 z-50">
          <div
            className="w-full max-w-[300px] rounded-[24px] p-4 shadow-lg"
            style={{
              background: "#ffffff",
              border: `1px solid #000000`,
              boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
            }}
          >
            <div
              className="text-[15px] text-center mb-2"
              style={{ color: TEXT, fontWeight: 500, letterSpacing: "0.04em" }}
            >
              Choose action
            </div>

            <div
              className="text-[12px] text-center mb-5"
              style={{ color: TEXT, opacity: 0.65, letterSpacing: "0.06em" }}
            >
              {purgeChoice.from} → {purgeChoice.to}
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    pendingRequestIdRef.current += 1;
                    setState((s) => applyMove(s, purgeChoice.move));
                    setPurgeChoice(null);
                  }}
                  className="flex-1 py-3 rounded-2xl text-[13px] transition-all duration-150 hover:opacity-80 hover:-translate-y-[1px]"
                  style={{
                    background: "transparent",
                    color: ACCENT,
                    border: `1px solid ${ACCENT}`,
                    fontWeight: 500,
                  }}
                >
                  Purge
                </button>

                <button
                  onClick={() => {
                    setState((s) => ({
                    ...s,
                    selected: purgeChoice.to,
                    status: s.board[purgeChoice.to] ? `Selected: ${pieceName(s.board[purgeChoice.to]!.type)} on ${purgeChoice.to}.` : s.status,
                  }));
                    setPurgeChoice(null);
                  }}
                  className="flex-1 py-3 rounded-2xl text-[13px] transition-all duration-150 hover:opacity-80 hover:-translate-y-[1px]"
                  style={{
                    background: "transparent",
                    color: TEXT,
                    border: `0.7px solid ${BORDER}`,
                    fontWeight: 400,
                  }}
                >
                  Select
                </button>
              </div>

              <button
                onClick={() => setPurgeChoice(null)}
                className="w-full py-2 text-[11px] transition-all duration-150 hover:opacity-100 hover:-translate-y-[1px]"
                style={{ color: TEXT, opacity: 0.55, fontWeight: 400 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {state.pendingPromotion && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md rounded-3xl p-5 border" style={{ background: "#ffffff", borderColor: BORDER }}>
            <div className="text-xl font-semibold mb-3" style={{ color: TEXT }}>Choose promotion</div>
            <div className="grid grid-cols-4 gap-3">
              {PROMOTION_TYPES.map((type) => {
                const isWhite = state.pendingPromotion?.color === "white";
                return (
                  <button
                    key={type}
                    onClick={() => handlePromotion(type)}
                    className="rounded-2xl p-4 text-6xl leading-none transition-all duration-150 hover:opacity-85 hover:-translate-y-[1px]"
                    style={{
                      background: "#ffffff",
                      color: isWhite ? "#ffffff" : "#000000",
                      textShadow: isWhite ? "0 0 1px #000, 0 0 1px #000" : "none",
                      WebkitTextStroke: isWhite ? "0.8px #000" : undefined,
                    }}
                  >
                    {GLYPHS[state.pendingPromotion!.color][type]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {state.showRules && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-2 z-50" onClick={() => setState((s) => ({ ...s, showRules: false }))}>
          <div
            className="w-full max-w-3xl max-h-[88vh] overflow-auto rounded-[24px] p-4 shadow-lg"
            style={{
              background: "#ffffff",
              border: `1px solid #000000`,
              boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
              color: TEXT,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-[15px]" style={{ fontWeight: 500, letterSpacing: "0.04em" }}>
                Rules & Info
              </div>
              <button
                onClick={() => setState((s) => ({ ...s, showRules: false }))}
                className="px-3 py-1.5 rounded-xl text-[12px] transition-all duration-150 hover:opacity-80 hover:-translate-y-[1px]"
                style={{ background: "transparent", border: `1px solid #000000`, color: TEXT }}
              >
                Close
              </button>
            </div>
            <div className="space-y-3 text-[12px] leading-6" style={{ opacity: 0.9 }}>
              <p>Paranoia Chess is part of the variants of Yanevi family (this time developed by Kalin, Ivaylo and Cecilia - for the aesthetics). The fundaments were layed at the end of 2025 during a conversation on a chilly, rather rushed walk along the Thames banks during our Christmas trip to London. Of course, afterwards - during our trials with Ivaylo, and later on against the computer engine - what initially seemed a simple modest variant turned out to be more complex, making us remove some initial rule ideas like suicides, rooks as fifth columns, revealing a fifth column and playing on the same turn.</p>
              <p>The main idea of the variant is to have a spy/agent - a 'fifth column' - among the opposite side, which in turn should trigger certain Cold War-like paranoia resulting in purging of one’s own pieces and suboptimal moves driven by fear of 'your peoples'.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>1.</span> The board starts from the normal classical chess setup.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>2.</span> At game start, one pawn, bishop, or knight from each side is randomly assigned to the opponent. That hidden asset is the "fifth column".</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>3.</span> Only the opponent knows which piece it is.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>4.</span> On any turn, including the first, a player may reveal their own fifth column instead of making a move. The revealed piece immediately changes to that player's color and from then on behaves as that side's piece. If it came from a pawn that later promoted, the same physical piece can still be revealed.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>5.</span> Until a side's hidden "fifth column" is revealed, the host player may continue purging their own pawns, bishops, and knights, even if the hidden piece has already been captured or purged.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>6.</span> If a hidden "fifth column" piece is purged or captured by the opponent before being revealed, its identity remains unknown to the host player until the end of the game.</p>
              <p><span style={{ color: ACCENT, fontWeight: 500 }}>7.</span> Otherwise the game follows normal chess movement, check, checkmate, stalemate, promotion, castling, and en passant.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
