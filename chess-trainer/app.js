// Chess Vision Trainer App
class ChessVisionTrainer {
    constructor() {
        this.chess = null;
        this.boardElement = document.getElementById('board');
        this.timerElement = document.getElementById('timer');
        this.movesFoundElement = document.getElementById('moves-found');
        this.totalMovesElement = document.getElementById('total-moves');
        this.mistakesElement = document.getElementById('mistakes');
        this.foundMovesListElement = document.getElementById('found-moves-list');
        this.fromSquareElement = document.getElementById('from-square');
        this.toSquareElement = document.getElementById('to-square');
        this.turnTextElement = document.getElementById('turn-text');
        this.startBtn = document.getElementById('start-btn');
        this.newPositionBtn = document.getElementById('new-position-btn');
        this.hintBtn = document.getElementById('hint-btn');
        this.resultModal = document.getElementById('result-modal');

        this.selectedSquare = null;
        this.legalMoves = [];
        this.foundMoves = new Set();
        this.mistakes = 0;
        this.timerInterval = null;
        this.startTime = null;
        this.isPlaying = false;

        this.pieces = {
            'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟',
            'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙'
        };

        this.setupEventListeners();
        this.initializeBoard();
    }

    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startGame());
        this.newPositionBtn.addEventListener('click', () => this.newPosition());
        this.hintBtn.addEventListener('click', () => this.showHint());
        document.getElementById('play-again-btn').addEventListener('click', () => this.playAgain());
    }

    initializeBoard() {
        this.boardElement.innerHTML = '';
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const square = document.createElement('div');
                const file = String.fromCharCode(97 + col);
                const rank = 8 - row;
                const squareName = file + rank;

                square.className = `square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.square = squareName;
                square.addEventListener('click', () => this.handleSquareClick(squareName));

                this.boardElement.appendChild(square);
            }
        }
    }

    renderBoard() {
        const board = this.chess.board();
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const file = String.fromCharCode(97 + col);
                const rank = 8 - row;
                const squareName = file + rank;
                const squareElement = this.boardElement.querySelector(`[data-square="${squareName}"]`);

                const piece = board[row][col];
                if (piece) {
                    const pieceSymbol = piece.color === 'w'
                        ? this.pieces[piece.type.toUpperCase()]
                        : this.pieces[piece.type];
                    squareElement.textContent = pieceSymbol;
                    squareElement.classList.add(piece.color === 'w' ? 'white-piece' : 'black-piece');
                    squareElement.classList.remove(piece.color === 'w' ? 'black-piece' : 'white-piece');
                } else {
                    squareElement.textContent = '';
                    squareElement.classList.remove('white-piece', 'black-piece');
                }

                // Reset square styling
                squareElement.classList.remove('selected', 'from-selected', 'hint', 'found');
            }
        }

        // Update turn indicator
        const turn = this.chess.turn();
        this.turnTextElement.textContent = turn === 'w' ? 'White to move' : 'Black to move';
        this.turnTextElement.parentElement.className = `turn-indicator ${turn === 'w' ? 'white' : 'black'}`;
    }

    generateRandomPosition() {
        // Collection of interesting positions for training
        const positions = [
            // Opening positions with many moves
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
            'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
            'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',

            // Middlegame positions
            'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            'r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5',
            'rnbq1rk1/ppp1bppp/4pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQ - 2 5',
            'r1bq1rk1/pppnbppp/4pn2/3p4/2PP4/2NBPN2/PP3PPP/R1BQK2R w KQ - 2 7',

            // Tactical positions
            'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
            'r1b1kbnr/pppp1ppp/2n5/4p3/2B1P2q/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            'r1bqkbnr/ppp2ppp/2np4/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
            'rnbqk2r/ppp2ppp/3bpn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 2 5',

            // Endgame positions
            'r3k2r/ppp2ppp/2n2n2/3pp3/1bB1P1b1/2NP1N2/PPP2PPP/R3K2R w KQkq - 0 8',
            '2r2rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/2R2RK1 w - - 0 12',
            'r4rk1/1pp2ppp/p1n1pn2/3p4/1bPP4/2NBPN2/PP3PPP/R3K2R w KQ - 0 10',
            '3r1rk1/ppp2ppp/2n2n2/3pp3/8/2NP1N2/PPP2PPP/R3K2R w KQ - 0 10',

            // Complex positions with lots of moves
            'r2qkb1r/ppp1pppp/2n2n2/3p4/3P1Bb1/2N2N2/PPP1PPPP/R2QKB1R w KQkq - 4 5',
            'r1bqk2r/ppp2ppp/2n2n2/3pp3/1bP5/2N2NP1/PP1PPP1P/R1BQKB1R w KQkq - 0 5',
            'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7',

            // Starting position
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        ];

        return positions[Math.floor(Math.random() * positions.length)];
    }

    startGame() {
        this.chess = new Chess(this.generateRandomPosition());
        this.legalMoves = this.chess.moves({ verbose: true });
        this.foundMoves = new Set();
        this.mistakes = 0;
        this.selectedSquare = null;
        this.isPlaying = true;

        this.renderBoard();
        this.updateStats();
        this.resetSelection();

        this.startBtn.disabled = true;
        this.newPositionBtn.disabled = false;
        this.hintBtn.disabled = false;

        // Start timer
        this.startTime = Date.now();
        this.timerInterval = setInterval(() => this.updateTimer(), 10);
    }

    newPosition() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
        this.startGame();
    }

    handleSquareClick(squareName) {
        if (!this.isPlaying) return;

        const squareElement = this.boardElement.querySelector(`[data-square="${squareName}"]`);

        if (this.selectedSquare === null) {
            // First click - select starting square
            const piece = this.chess.get(squareName);
            const turn = this.chess.turn();

            // Check if there's a piece of the correct color on this square
            if (piece && piece.color === turn) {
                // Check if this piece has any legal moves
                const pieceMoves = this.legalMoves.filter(m => m.from === squareName);
                if (pieceMoves.length > 0) {
                    this.selectedSquare = squareName;
                    this.fromSquareElement.textContent = squareName;
                    squareElement.classList.add('selected');
                }
            }
        } else {
            // Second click - select destination square
            if (squareName === this.selectedSquare) {
                // Clicked same square - deselect
                this.resetSelection();
                return;
            }

            this.toSquareElement.textContent = squareName;

            // Check if this is a legal move
            const moveKey = this.selectedSquare + '-' + squareName;
            const move = this.legalMoves.find(m => m.from === this.selectedSquare && m.to === squareName);

            if (move && !this.foundMoves.has(moveKey)) {
                // Correct! Found a legal move
                this.foundMoves.add(moveKey);
                this.addFoundMove(move);
                this.flashSquare(squareName, 'correct');

                // Mark squares that are part of found moves
                this.updateFoundSquares();

                // Check if all moves found
                if (this.foundMoves.size === this.legalMoves.length) {
                    this.gameComplete();
                }
            } else if (this.foundMoves.has(moveKey)) {
                // Already found this move
                this.flashSquare(squareName, 'wrong');
            } else {
                // Incorrect move
                this.mistakes++;
                this.mistakesElement.textContent = this.mistakes;
                this.flashSquare(squareName, 'wrong');
            }

            this.updateStats();
            this.resetSelection();
        }
    }

    flashSquare(squareName, type) {
        const squareElement = this.boardElement.querySelector(`[data-square="${squareName}"]`);
        squareElement.classList.add(type === 'correct' ? 'correct-flash' : 'wrong-flash');
        setTimeout(() => {
            squareElement.classList.remove('correct-flash', 'wrong-flash');
        }, 300);
    }

    resetSelection() {
        if (this.selectedSquare) {
            const prevSquare = this.boardElement.querySelector(`[data-square="${this.selectedSquare}"]`);
            prevSquare.classList.remove('selected');
        }
        this.selectedSquare = null;
        this.fromSquareElement.textContent = '-';
        this.toSquareElement.textContent = '-';
    }

    updateFoundSquares() {
        // Clear all found markers first
        document.querySelectorAll('.square.found').forEach(sq => sq.classList.remove('found'));

        // Mark squares involved in found moves
        this.foundMoves.forEach(moveKey => {
            const [from, to] = moveKey.split('-');
            this.boardElement.querySelector(`[data-square="${to}"]`).classList.add('found');
        });
    }

    addFoundMove(move) {
        const moveTag = document.createElement('span');
        moveTag.className = 'move-tag';
        moveTag.textContent = move.san;
        this.foundMovesListElement.appendChild(moveTag);
    }

    updateStats() {
        this.movesFoundElement.textContent = this.foundMoves.size;
        this.totalMovesElement.textContent = this.legalMoves.length;
    }

    updateTimer() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        this.timerElement.textContent = elapsed.toFixed(2) + 's';
    }

    showHint() {
        if (!this.isPlaying) return;

        // Find a move that hasn't been found yet
        for (const move of this.legalMoves) {
            const moveKey = move.from + '-' + move.to;
            if (!this.foundMoves.has(moveKey)) {
                // Highlight the from square
                const fromSquare = this.boardElement.querySelector(`[data-square="${move.from}"]`);
                fromSquare.classList.add('hint');

                // Remove highlight after 1 second
                setTimeout(() => {
                    fromSquare.classList.remove('hint');
                }, 1000);

                // Add a small penalty
                this.mistakes += 0.5;
                this.mistakesElement.textContent = this.mistakes;
                break;
            }
        }
    }

    gameComplete() {
        this.isPlaying = false;
        clearInterval(this.timerInterval);

        const finalTime = ((Date.now() - this.startTime) / 1000).toFixed(2);
        const score = Math.max(0, Math.round(1000 - (parseFloat(finalTime) * 10) - (this.mistakes * 50)));

        document.getElementById('final-time').textContent = finalTime + 's';
        document.getElementById('final-moves').textContent = this.foundMoves.size + '/' + this.legalMoves.length;
        document.getElementById('final-mistakes').textContent = this.mistakes;
        document.getElementById('final-score').textContent = score + ' points';

        this.resultModal.classList.remove('hidden');
    }

    playAgain() {
        this.resultModal.classList.add('hidden');
        this.foundMovesListElement.innerHTML = '';
        this.startBtn.disabled = false;
        this.newPositionBtn.disabled = true;
        this.hintBtn.disabled = true;
        this.timerElement.textContent = '0.00s';
        this.movesFoundElement.textContent = '0';
        this.totalMovesElement.textContent = '0';
        this.mistakesElement.textContent = '0';

        // Clear board state
        this.chess = new Chess();
        this.renderBoard();

        // Auto-start new game
        this.startGame();
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChessVisionTrainer();
});
