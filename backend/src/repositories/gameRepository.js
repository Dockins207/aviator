const GameBoardService = require('../services/gameBoardService');

class GameRepository {
  constructor() {
    // In-memory storage for game results (can be replaced with database later)
    this.gameHistory = [];
  }

  // Persist game results
  async saveGameResult(gameResult) {
    // Store in game history
    this.gameHistory.unshift({
      gameId: gameResult.gameId,
      crashPoint: gameResult.crashPoint,
      timestamp: new Date(),
      players: gameResult.players.map(player => ({
        playerId: player.playerId,
        betAmount: player.betAmount,
        status: player.status
      }))
    });

    // Limit history to last 100 games
    if (this.gameHistory.length > 100) {
      this.gameHistory.pop();
    }

    console.log('Game result saved:', gameResult);
    return gameResult;
  }

  // Retrieve recent game history
  async getGameHistory(limit = 10) {
    return this.gameHistory.slice(0, limit);
  }

  // Get last game result
  async getLastGameResult() {
    return this.gameHistory[0] || null;
  }
}

module.exports = new GameRepository();
