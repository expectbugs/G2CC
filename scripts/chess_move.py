#!/usr/bin/env python3
"""Chess move engine (upgrades.md Phase 11) — one stateless round per
invocation: apply the player's SAN move (if any) to the FEN, let Stockfish
reply (Skill Level from the menu; depth-LIMITED — a compute bound, not a
wall-clock kill), and report the new state + legal moves for the picker.

Statelessness is the design: the server holds only the FEN string, every
invocation is a fresh subprocess (B4), and there is no long-lived engine to
babysit. popen_uci runs with timeout=None — no handshake clock (rules);
Stockfish is local and answers in milliseconds.

stdin:  JSON {"fen": str|null (null = new game), "move": SAN|null, "skill": 0-20}
stdout: JSON {"fen", "engineMove": SAN|null, "legalMoves": [SAN...],
              "status": "ongoing"|"checkmate"|"stalemate"|"draw",
              "winner": "you"|"stockfish"|null, "check": bool, "moveNumber": int}
"""
import json
import sys

import chess
import chess.engine

STOCKFISH = "/usr/bin/stockfish"
ENGINE_DEPTH = 10  # resource cap (deterministic-ish bound), not a timeout


def status_of(board):
    if board.is_checkmate():
        return "checkmate"
    if board.is_stalemate():
        return "stalemate"
    if board.is_insufficient_material() or board.can_claim_draw():
        return "draw"
    return "ongoing"


def main():
    req = json.load(sys.stdin)
    fen = req.get("fen")
    board = chess.Board(fen) if fen else chess.Board()
    skill = max(0, min(20, int(req.get("skill", 5))))

    engine_move = None
    move = req.get("move")
    if move:
        board.push_san(move)  # raises on illegal SAN — loud exit 1
        if status_of(board) == "ongoing":
            engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH, timeout=None)
            try:
                engine.configure({"Skill Level": skill})
                result = engine.play(board, chess.engine.Limit(depth=ENGINE_DEPTH))
                engine_move = board.san(result.move)
                board.push(result.move)
            finally:
                engine.quit()

    st = status_of(board)
    winner = None
    if st == "checkmate":
        # side to move is mated; the player is always WHITE in this UI
        winner = "you" if board.turn == chess.BLACK else "stockfish"
    print(json.dumps({
        "fen": board.fen(),
        "engineMove": engine_move,
        "legalMoves": sorted(board.san(m) for m in board.legal_moves),
        "status": st,
        "winner": winner,
        "check": board.is_check(),
        "moveNumber": board.fullmove_number,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"chess_move error: {e}\n")
        sys.exit(1)
