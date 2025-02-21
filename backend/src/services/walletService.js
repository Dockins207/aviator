import WalletRepository from '../repositories/walletRepository.js';
import RedisRepository from '../redis-services/redisRepository.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';

// Distributed locking configuration
const WALLET_LOCK_DURATION = 10000; // 10 seconds
const WALLET_LOCK_RETRY_DELAY = 500; // 500ms between retries

class WalletService {
  // Acquire a distributed lock for a wallet transaction
  async acquireWalletLock(userId, lockReason) {
    const lockKey = `wallet_lock:${userId}`;
    const lockValue = uuidv4();
    const redisClient = await RedisRepository.getClient();

    try {
      // Try to acquire lock with NX (only if not exists) and PX (expiry in milliseconds)
      const lockAcquired = await redisClient.set(lockKey, lockValue, {
        NX: true,
        PX: WALLET_LOCK_DURATION
      });

      if (!lockAcquired) {
        logger.warn('WALLET_LOCK_CONTENTION', {
          userId,
          lockReason,
          message: 'Unable to acquire wallet lock'
        });
        throw new Error('Wallet transaction in progress');
      }

      return { lockKey, lockValue };
    } catch (error) {
      logger.error('WALLET_LOCK_ACQUISITION_FAILED', {
        userId,
        lockReason,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Release a distributed wallet lock
  async releaseWalletLock(lockKey, lockValue) {
    const redisClient = await RedisRepository.getClient();

    try {
      // Lua script to ensure we only release our own lock
      const unlockScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;

      await redisClient.eval(unlockScript, {
        keys: [lockKey],
        arguments: [lockValue]
      });

      logger.info('WALLET_LOCK_RELEASED', { lockKey });
    } catch (error) {
      logger.error('WALLET_LOCK_RELEASE_FAILED', {
        lockKey,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Initialize wallet for a new user during registration
  async initializeWallet(userId) {
    try {
      const walletId = uuidv4();
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_id:${userId}`;

      // Create wallet in PostgreSQL
      const createWalletQuery = `
        INSERT INTO wallets (wallet_id, user_id, balance, currency) 
        VALUES ($1, $2, 0, 'KSH')
        RETURNING *
      `;
      const client = await WalletRepository.getPoolClient();
      const walletResult = await client.query(createWalletQuery, [walletId, userId]);

      // Cache wallet ID in Redis
      await redisClient.set(redisCacheKey, walletId, { 
        EX: 24 * 60 * 60 // 24 hours expiration 
      });

      logger.info('WALLET_INITIALIZED', { 
        userId, 
        walletId 
      });

      return walletResult.rows[0];
    } catch (error) {
      logger.error('WALLET_INITIALIZATION_FAILED', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get user wallet details with Redis caching
  async getWallet(userId) {
    try {
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      // Return wallet with formatted balance details
      return {
        ...wallet,
        balance: wallet.balance,
        formattedBalance: wallet.balance.toLocaleString('en-US', { style: 'currency', currency: wallet.currency }),
        displayBalance: `${wallet.currency} ${wallet.balance.toFixed(2)}`
      };
    } catch (error) {
      logger.error('WALLET_RETRIEVAL_FAILED', {
        userId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Deposit funds with distributed transaction and caching
  async deposit(userId, amount, description = 'Manual Deposit', paymentMethod = 'manual', currency = 'KSH') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'deposit_transaction'
      );

      // Perform deposit in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find or create wallet
        amount, 
        description,
        paymentMethod,
        currency
      );

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

      // Log transaction
      logger.info('WALLET_DEPOSIT_COMPLETED', { 
        userId, 
        amount,
        newBalance: result.newBalance,
        walletId: result.walletId,
        paymentMethod,
        currency
      });

      return result;
    } catch (error) {
      logger.error('WALLET_DEPOSIT_FAILED', { 
        userId, 
        amount,
        paymentMethod,
        currency,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Place bet with distributed transaction and caching
  async placeBet(userId, betAmount, gameId) {
    let walletLock = null;
    try {
      // Validate bet amount
      if (betAmount <= 0) {
        throw new Error('Bet amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'bet_placement_transaction'
      );

      // Perform bet placement in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        -betAmount,  // Negative amount for bet
        `Bet Placement for Game ${gameId}`,
        'game_bet',
        'KSH'
      );

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'bet',
          amount: betAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      // Log transaction
      logger.info('WALLET_BET_PLACED', { 
        userId, 
        betAmount,
        gameId,
        newBalance: result.newBalance,
        walletId: result.walletId
      });

      return result;
    } catch (error) {
      logger.error('WALLET_BET_PLACEMENT_FAILED', { 
        userId, 
        betAmount,
        gameId,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Process game winnings with distributed transaction and caching
  async processWinnings(userId, winAmount, gameId) {
    let walletLock = null;
    try {
      // Validate win amount
      if (winAmount <= 0) {
        throw new Error('Win amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'game_winnings_transaction'
      );

      // Process winnings in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        winAmount,
        `Game Winnings for Game ${gameId}`,
        'game_win',
        'KSH'
      );

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'win',
          amount: winAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      // Log transaction
      logger.info('WALLET_WINNINGS_PROCESSED', { 
        userId, 
        winAmount,
        gameId,
        newBalance: result.newBalance,
        walletId: result.walletId
      });

      return result;
    } catch (error) {
      logger.error('WALLET_WINNINGS_PROCESSING_FAILED', { 
        userId, 
        winAmount,
        gameId,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Withdraw funds with distributed transaction and caching
  async withdraw(userId, amount, description = 'Manual Withdrawal') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'withdrawal_transaction'
      );

      // Perform withdrawal in PostgreSQL
      const result = await WalletRepository.recordTransaction(
        userId, 
        'withdraw', 
        amount, 
        null,  // Will be calculated in the method
        { description }
      );

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

      // Log transaction
      logger.info('WALLET_WITHDRAWAL_COMPLETED', { 
        userId, 
        amount,
        newBalance: result.newBalance
      });

      return result;
    } catch (error) {
      logger.error('WALLET_WITHDRAWAL_FAILED', { 
        userId, 
        amount,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Get transaction history with optional Redis caching
  async getTransactionHistory(userId, limit = 50, offset = 0) {
    try {
      // Fetch transaction history from PostgreSQL
      const transactions = await WalletRepository.getTransactionHistory(
        userId, 
        limit, 
        offset
      );

      // Optional: Cache recent transaction history in Redis
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `transaction_history:${userId}:${limit}:${offset}`;
      await redisClient.set(
        redisCacheKey, 
        JSON.stringify(transactions), 
        { EX: 3600 }  // 1-hour cache expiration
      );

      return transactions;
    } catch (error) {
      logger.error('TRANSACTION_HISTORY_RETRIEVAL_FAILED', { 
        userId, 
        limit,
        offset,
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Create wallet for a user if not exists
  async createWallet(userId) {
    let walletLock = null;
    try {
      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'wallet_creation'
      );

      // Create wallet in PostgreSQL
      const wallet = await WalletRepository.createWallet(userId);
      
      if (!wallet) {
        logger.error('Wallet creation failed', { 
          userId, 
          errorMessage: 'Unable to create wallet' 
        });
        throw new Error('Unable to create wallet');
      }

      // Cache wallet in Redis
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, wallet.balance);

      return wallet;
    } catch (error) {
      logger.error('Wallet creation failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Get user wallet details
  async getUserProfileBalance(userId) {
    try {
      // Validate userId
      if (!userId) {
        logger.error('INVALID_USER_ID', { 
          message: 'User ID is undefined or null',
          userId
        });
        throw new Error('Invalid User ID');
      }

      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      
      logger.info('BALANCE_RETRIEVAL_ATTEMPT', { 
        userId, 
        timestamp: new Date().toISOString() 
      });

      // Verify and sync balance
      const balanceVerification = await WalletRepository.verifyAndSyncBalance(userId);

      // Additional logging for balance verification
      logger.info('BALANCE_VERIFICATION_RESULT', {
        userId,
        balanceVerification: {
          walletId: balanceVerification.walletId,
          currentBalance: balanceVerification.currentBalance,
          calculatedBalance: balanceVerification.calculatedBalance,
          corrected: balanceVerification.corrected,
          difference: balanceVerification.difference,
          reason: balanceVerification.reason
        }
      });

      // Prepare consistent response structure
      const balanceResponse = {
        userId,
        balance: balanceVerification.calculatedBalance,
        currency: 'KSH',  // Default currency
        formattedBalance: `KSH ${balanceVerification.calculatedBalance.toFixed(2)}`,
        balanceVerified: balanceVerification.corrected,
        balanceCorrectionReason: balanceVerification.reason || null
      };

      // Cache in Redis
      await redisClient.set(redisCacheKey, balanceResponse.balance);

      logger.info('BALANCE_RETRIEVAL_SUCCESS', { 
        userId, 
        balance: balanceResponse.balance,
        corrected: balanceResponse.balanceVerified
      });

      return balanceResponse;
    } catch (error) {
      logger.error('User profile balance retrieval failed', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  // Deposit funds into user wallet
  async depositFunds(userId, amount, description = 'Manual Deposit') {
    let walletLock;
    try {
      // Validate input
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'deposit_transaction'
      );

      // First, get the wallet ID for the user
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_id:${userId}`;
      const balanceCacheKey = `wallet_balance:${userId}`;
      
      // Cache expiration time (24 hours)
      const CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours in seconds

      let walletId = await redisClient.get(redisCacheKey);

      // Perform deposit in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        walletId || undefined,  // Pass undefined if walletId is null
        amount, 
        description
      );

      // Update Redis cache with new balance and set expiration
      await redisClient.set(balanceCacheKey, result.newBalance, { 
        EX: CACHE_EXPIRATION 
      });

      // Cache wallet ID if not already cached and set expiration
      if (!walletId) {
        await redisClient.set(redisCacheKey, result.walletId, { 
          EX: CACHE_EXPIRATION 
        });
      }

      return result;
    } catch (error) {
      logger.error('Funds deposit failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Withdraw funds from user wallet
  async withdrawFunds(userId, amount, description = 'Manual Withdrawal') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'withdrawal_transaction'
      );

      // Cache expiration time (24 hours)
      const CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours in seconds

      // Perform withdrawal in PostgreSQL
      const result = await WalletRepository.withdraw(userId, amount, description);

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const balanceCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(balanceCacheKey, result.newBalance, { 
        EX: CACHE_EXPIRATION 
      });

      return result;
    } catch (error) {
      logger.error('Funds withdrawal failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Cashout method with real-time balance update
  async cashout(userId, cashoutAmount, gameId) {
    let walletLock = null;
    try {
      // Validate cashout amount
      if (cashoutAmount <= 0) {
        throw new Error('Cashout amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'cashout_transaction'
      );

      // Perform cashout in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        cashoutAmount,  // Positive amount for cashout
        `Game Cashout for Game ${gameId}`,
        'game_cashout',
        'KSH'
      );

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'cashout',
          amount: cashoutAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      // Log transaction
      logger.info('WALLET_CASHOUT_SUCCESS', { 
        userId, 
        cashoutAmount,
        gameId,
        newBalance: result.newBalance,
        walletId: result.walletId
      });

      return result;
    } catch (error) {
      logger.error('WALLET_CASHOUT_FAILED', { 
        userId, 
        cashoutAmount,
        gameId,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Clear outdated Redis entries for a specific user
  async clearOutdatedRedisEntries(userId) {
    try {
      const redisClient = await RedisRepository.getClient();
      
      // Define keys to clean
      const keyPatterns = [
        `wallet_balance:${userId}`,
        `wallet_id:${userId}`,
        `transaction_history:${userId}:*`,
        `user_token:${userId}`,
        `bet_history:${userId}:*`
      ];

      // Iterate and delete matching keys
      for (const pattern of keyPatterns) {
        const keys = await redisClient.keys(pattern);
        
        if (keys.length > 0) {
          await redisClient.del(...keys);
          
          logger.info('REDIS_KEYS_CLEARED', {
            userId,
            pattern,
            clearedKeysCount: keys.length
          });
        }
      }
    } catch (error) {
      logger.error('REDIS_CLEANUP_FAILED', {
        userId,
        errorMessage: error.message
      });
    }
  }

  // Periodic cleanup of user's Redis data
  async scheduleRedisCleanup(userId, intervalMinutes = 60) {
    try {
      const redisClient = await RedisRepository.getClient();
      const cleanupKey = `redis_cleanup:${userId}`;

      // Check if cleanup is already scheduled
      const existingCleanup = await redisClient.get(cleanupKey);
      if (existingCleanup) return;

      // Schedule cleanup
      await redisClient.set(
        cleanupKey, 
        'scheduled', 
        { 
          EX: intervalMinutes * 60, // Convert minutes to seconds
          NX: true // Only set if not exists
        }
      );

      // Perform cleanup
      await this.clearOutdatedRedisEntries(userId);
    } catch (error) {
      logger.error('REDIS_CLEANUP_SCHEDULING_FAILED', {
        userId,
        errorMessage: error.message
      });
    }
  }

  // Manual cleanup method for immediate use
  async manualRedisCleanup(userId) {
    try {
      await this.clearOutdatedRedisEntries(userId);
      logger.info('MANUAL_REDIS_CLEANUP_COMPLETED', { userId });
      return true;
    } catch (error) {
      logger.error('MANUAL_REDIS_CLEANUP_FAILED', {
        userId,
        errorMessage: error.message
      });
      return false;
    }
  }
}

export default new WalletService();
