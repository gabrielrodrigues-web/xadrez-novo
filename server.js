const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const { Chess } = require('chess.js');

const DB_PATH = './database.json';
let users = {};

// Carrega o banco de dados com segurança
if (fs.existsSync(DB_PATH)) {
    try { 
        const fileData = fs.readFileSync(DB_PATH, 'utf8');
        if (fileData) users = JSON.parse(fileData);
    } catch (e) { 
        console.error("Erro ao carregar banco de dados, criando novo:", e);
        users = {}; 
    }
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2)); }

// Estrutura das Salas (Universos) - 900s (15 min)
const rooms = {
    "SubMundo": { players: [], game: null, timer: null, times: { w: 900, b: 900 }, rematch: [] },
    "Recanto dos pecadores": { players: [], game: null, timer: null, times: { w: 900, b: 900 }, rematch: [] },
    "Vozes sem fim": { players: [], game: null, timer: null, times: { w: 900, b: 900 }, rematch: [] },
    "Solidão": { players: [], game: null, timer: null, times: { w: 900, b: 900 }, rematch: [] }
};

app.use(express.static(__dirname));

function getRanking() {
    return Object.keys(users).map(nick => ({ nick, wins: users[nick].wins || 0 }))
        .sort((a, b) => b.wins - a.wins).slice(0, 5);
}

function startTimer(canal) {
    const room = rooms[canal];
    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
        // Verificação de segurança para evitar crash se o jogo for anulado
        if (!room.game || (room.players.filter(p => p.cor !== 'spectator').length < 2)) {
            clearInterval(room.timer);
            return;
        }

        if (room.game.isGameOver()) {
            clearInterval(room.timer);
            return;
        }

        const turn = room.game.turn(); 
        room.times[turn]--;

        io.to(canal).emit('sync_time', room.times);

        if (room.times[turn] <= 0) {
            clearInterval(room.timer);
            const winnerColor = turn === 'w' ? 'b' : 'w';
            const winnerPlayer = room.players.find(p => p.cor === winnerColor);
            
            let msg = "O TEMPO DE VIDA ACABOU.";
            if (winnerPlayer) {
                if(users[winnerPlayer.apelido]) {
                    users[winnerPlayer.apelido].wins++;
                    saveDB();
                }
                msg = `TEMPO ESGOTADO! Vitória de ${winnerPlayer.apelido}.`;
            }
            
            io.emit('atualizar_ranking', getRanking());
            io.to(canal).emit('fim_jogo', { msg });
            // Não deletamos o room.game imediatamente para permitir ver o tabuleiro final
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('entrar', (data) => {
        const { apelido, senha, canal } = data;
        const room = rooms[canal];

        if (!room) return socket.emit('erro', 'Universo inexistente.');

        if (users[apelido]) {
            if (users[apelido].senha !== senha) return socket.emit('erro', 'Senha incorreta.');
        } else {
            users[apelido] = { senha, wins: 0 }; saveDB();
        }

        socket.join(canal);

        let cor = 'spectator';
        const activePlayers = room.players.filter(p => p.cor !== 'spectator');
        
        // Verifica se o jogador já está na sala (reconexão)
        const existingPlayer = activePlayers.find(p => p.apelido === apelido);
        if (existingPlayer) {
             // Lógica de reconexão poderia ir aqui, mas simplificamos removendo o antigo
             room.players = room.players.filter(p => p.apelido !== apelido);
        }

        if (room.players.filter(p => p.cor !== 'spectator').length < 2) {
            const hasWhite = room.players.some(p => p.cor === 'w');
            cor = hasWhite ? 'b' : 'w';
            room.players.push({ id: socket.id, apelido, cor });
        } else {
            room.players.push({ id: socket.id, apelido, cor: 'spectator' });
            socket.emit('erro', 'Sala cheia. Você entrou como FANTASMA (Espectador).');
        }

        const playersNow = room.players.filter(p => p.cor !== 'spectator');
        
        // Início de jogo
        if (playersNow.length === 2 && (!room.game || room.game.isGameOver())) {
            room.game = new Chess();
            room.times = { w: 900, b: 900 };
            room.rematch = [];
            io.to(canal).emit('iniciar_jogo', { fen: room.game.fen() });
            startTimer(canal);
        } else if (room.game) {
            // Espectador ou reconexão entra no meio
            socket.emit('iniciar_jogo', { fen: room.game.fen() });
            socket.emit('sync_time', room.times);
        }

        socket.emit('logado', { apelido, cor, canal, ranking: getRanking() });
    });

    socket.on('enviar_msg', (data) => {
        io.to(data.canal).emit('receber_msg', data);
    });

    socket.on('movimento', (data) => {
        const room = rooms[data.canal];
        if (!room || !room.game) return;
        
        // Validação estrita de turno
        if (room.game.turn() !== data.cor) return;

        try {
            // Tenta realizar o movimento
            const move = room.game.move({ from: data.from, to: data.to, promotion: 'q' });
            
            if (move) {
                // Sucesso: atualiza todos
                io.to(data.canal).emit('atualizar_tabuleiro', { fen: room.game.fen(), lastMove: move });
                
                if (room.game.isGameOver()) {
                    clearInterval(room.timer);
                    let msg = "EMPATE NA ESCURIDÃO.";
                    
                    if (room.game.isCheckmate()) {
                        const winner = room.game.turn() === 'w' ? 'b' : 'w';
                        const winnerObj = room.players.find(p => p.cor === winner);
                        if (winnerObj) {
                            if(users[winnerObj.apelido]) users[winnerObj.apelido].wins++;
                            saveDB();
                            msg = `XEQUE-MATE! ${winnerObj.apelido} ceifou uma alma.`;
                        }
                    } else if (room.game.isDraw()) {
                        msg = "EMPATE! As forças se anularam.";
                    }

                    io.emit('atualizar_ranking', getRanking());
                    io.to(data.canal).emit('fim_jogo', { msg });
                }
            } else {
                // Movimento inválido lógico (regras do xadrez)
                throw new Error("Movimento ilegal");
            }
        } catch (e) {
            // CORREÇÃO DO CONGELAMENTO:
            // Se o movimento falhar (erro de parsing ou ilegal), enviamos o estado ATUAL
            // de volta apenas para quem tentou mover. Isso força a peça a voltar para o lugar.
            console.log(`Erro no movimento (${data.apelido}):`, e.message);
            socket.emit('atualizar_tabuleiro', { fen: room.game.fen(), lastMove: null });
        }
    });

    socket.on('pedir_revanche', (data) => {
        const room = rooms[data.canal];
        if (!room) return;

        if (!room.rematch.includes(socket.id)) {
            room.rematch.push(socket.id);
        }

        const activePlayers = room.players.filter(p => p.cor !== 'spectator');
        io.to(data.canal).emit('revanche_solicitada', `Revanche: ${room.rematch.length}/${activePlayers.length} aceitaram.`);

        if (room.rematch.length >= activePlayers.length && activePlayers.length === 2) {
            room.game = new Chess();
            room.times = { w: 900, b: 900 }; 
            room.rematch = [];
            io.to(data.canal).emit('iniciar_jogo', { fen: room.game.fen() });
            startTimer(data.canal);
        }
    });

    socket.on('disconnecting', () => {
        for (const canal of socket.rooms) {
            if (rooms[canal]) {
                const wasPlayer = rooms[canal].players.find(p => p.id === socket.id && p.cor !== 'spectator');
                rooms[canal].players = rooms[canal].players.filter(player => player.id !== socket.id);
                
                // Se um jogador ativo saiu, o jogo acaba/pausa
                if (wasPlayer) {
                    clearInterval(rooms[canal].timer);
                    rooms[canal].game = null; // Encerra o jogo atual
                    io.to(canal).emit('erro', `Oponente (${wasPlayer.apelido}) fugiu. O universo colapsou.`);
                    
                    // Reseta o estado para quem ficou esperar um novo oponente
                    rooms[canal].rematch = [];
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
