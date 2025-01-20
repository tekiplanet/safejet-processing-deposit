import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deposit } from '../entities/deposit.entity';
import { WalletBalance } from '../entities/wallet-balance.entity';
import { Token } from '../entities/token.entity';
import { Wallet } from '../entities/wallet.entity';
import { SystemSettings } from '../entities/system-settings.entity';
import { 
  providers,
  Contract,
  utils,
} from 'ethers';
import { WebSocketProvider, JsonRpcProvider } from '@ethersproject/providers';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { In, Not, IsNull } from 'typeorm';
import * as bitcoin from 'bitcoinjs-lib';
const TronWeb = require('tronweb');
type TronWebType = typeof TronWeb;
type TronWebInstance = InstanceType<TronWebType>;
import { Client } from 'xrpl';
type XrplClient = Client;

// ERC20 ABI for token transfers
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// Add these interfaces at the top of the file
interface BitcoinProvider {
  url: string;
  auth: {
    username: string;
    password: string;
  };
}

interface Providers {
  [key: string]: JsonRpcProvider | WebSocketProvider | BitcoinProvider | TronWebInstance | XrplClient;
}

// Add this interface at the top with other interfaces
interface BitcoinBlock {
  tx: Array<any>;
  height: number;
  hash: string;
  // Add other relevant fields
}

@Injectable()
export class DepositTrackingService implements OnModuleInit {
  private readonly logger = new Logger(DepositTrackingService.name);
  private readonly providers = new Map<string, Providers[string]>();
  private readonly CONFIRMATION_BLOCKS = {
    eth: {
      mainnet: 12,
      testnet: 5
    },
    bsc: {
      mainnet: 15,
      testnet: 6
    },
    btc: {
      mainnet: 3,
      testnet: 2
    },
    trx: {
      mainnet: 20,
      testnet: 10
    },
    xrp: {
      mainnet: 4,
      testnet: 2
    }
  } as const;

  private readonly PROCESSING_DELAYS = {
    eth: {
      blockDelay: this.configService.get('ETHEREUM_BLOCK_DELAY', 1000),
      checkInterval: this.configService.get('ETHEREUM_CHECK_INTERVAL', 30000)
    },
    bsc: {
      blockDelay: this.configService.get('BSC_BLOCK_DELAY', 500),
      checkInterval: this.configService.get('BSC_CHECK_INTERVAL', 30000)
    },
    bitcoin: {
      blockDelay: this.configService.get('BITCOIN_BLOCK_DELAY', 2000),
      checkInterval: this.configService.get('BITCOIN_CHECK_INTERVAL', 120000)
    },
    trx: {
      blockDelay: this.configService.get('TRON_BLOCK_DELAY', 5000),
      checkInterval: this.configService.get('TRON_CHECK_INTERVAL', 10000)
    },
    xrp: {
      blockDelay: this.configService.get('XRP_BLOCK_DELAY', 2000),
      checkInterval: this.configService.get('XRP_CHECK_INTERVAL', 30000)
    }
  };

  private readonly CHAIN_KEYS = {
    eth: 'eth',
    bsc: 'bsc',
    bitcoin: 'btc',
    trx: 'trx',
    xrp: 'xrp'
  } as const;

  private blockQueues: {
    [key: string]: {
        isProcessing: boolean;
        queue: number[];
    };
  } = {};

  constructor(
    @InjectRepository(Deposit)
    private depositRepository: Repository<Deposit>,
    @InjectRepository(WalletBalance)
    private walletBalanceRepository: Repository<WalletBalance>,
    @InjectRepository(Token)
    private tokenRepository: Repository<Token>,
    @InjectRepository(Wallet)
    private walletRepository: Repository<Wallet>,
    private configService: ConfigService,
    @InjectRepository(SystemSettings)
    private systemSettingsRepository: Repository<SystemSettings>,
  ) {}

  async onModuleInit() {
    // Initialize queues for each chain
    ['eth_mainnet', 'eth_testnet', 'bsc_mainnet', 'bsc_testnet'].forEach(chain => {
        this.blockQueues[chain] = {
            isProcessing: false,
            queue: []
        };
    });
    
    await this.initializeProviders();
    await this.startMonitoring();
  }

  private async initializeProviders() {
    // Initialize EVM providers (Ethereum, BSC)
    const evmNetworks = {
      eth: {
        mainnet: this.configService.get('ETHEREUM_MAINNET_RPC'),
        testnet: this.configService.get('ETHEREUM_TESTNET_RPC'),
      },
      bsc: {
        mainnet: this.configService.get('BSC_MAINNET_RPC'),
        testnet: this.configService.get('BSC_TESTNET_RPC'),
      }
    };

    // Setup EVM providers
    for (const [chain, networks] of Object.entries(evmNetworks)) {
      for (const [network, rpcUrl] of Object.entries(networks)) {
        const providerKey = `${chain}_${network}`;
        if (typeof rpcUrl === 'string') {
          try {
            let provider: JsonRpcProvider | WebSocketProvider;
            if (rpcUrl.startsWith('ws')) {
              provider = new WebSocketProvider(rpcUrl);
            } else {
              provider = new JsonRpcProvider(rpcUrl);
            }
            
            const blockNumber = await provider.getBlockNumber();
            this.providers.set(providerKey, provider);
            this.logger.log(`${chain.toUpperCase()} ${network} provider initialized successfully, current block: ${blockNumber}`);
          } catch (error) {
            this.logger.error(`Failed to initialize ${chain.toUpperCase()} ${network} provider: ${error.message}`);
          }
        }
      }
    }

    // Initialize Bitcoin provider
    const bitcoinNetworks = {
      mainnet: this.configService.get('BITCOIN_MAINNET_RPC'),
      testnet: this.configService.get('BITCOIN_TESTNET_RPC'),
    };

    for (const [network, rpcUrl] of Object.entries(bitcoinNetworks)) {
      const providerKey = `btc_${network}`;
      try {
        const provider = {
          url: rpcUrl,
          auth: {
            username: this.configService.get('BITCOIN_RPC_USER'),
            password: this.configService.get('BITCOIN_RPC_PASS'),
          }
        } as BitcoinProvider;

        // Test connection
        const blockCount = await this.bitcoinRpcCall(provider, 'getblockcount', []);
        this.providers.set(providerKey, provider);
        this.logger.log(`Bitcoin ${network} provider initialized successfully, current block: ${blockCount}`);
      } catch (error) {
        this.logger.error(`Failed to initialize Bitcoin ${network} provider: ${error.message}`);
      }
    }

    // Initialize TRON provider
    const tronNetworks = {
      mainnet: this.configService.get('TRON_MAINNET_API'),
      testnet: this.configService.get('TRON_TESTNET_API'),
    };

    for (const [network, apiUrl] of Object.entries(tronNetworks)) {
      const providerKey = `trx_${network}`;
      
      try {
        const apiKey = this.configService.get('TRON_API_KEY');
        if (!apiKey) {
          this.logger.error('TRON_API_KEY not found in environment variables');
          continue;
        }

        // Create TronWeb instance
        const tronWeb = new TronWeb({
          fullNode: apiUrl,
          solidityNode: apiUrl,
          eventServer: apiUrl,
          privateKey: '', // Empty for read-only
          headers: {
            "TRON-PRO-API-KEY": apiKey,
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
        });

        // Test connection before setting provider
        const block = await tronWeb.trx.getCurrentBlock();
        if (!block) {
          throw new Error('Could not fetch current block');
        }

        this.providers.set(providerKey, tronWeb);
        this.logger.log(`TRON ${network} provider initialized successfully, current block: ${block.block_header.raw_data.number}`);
      } catch (error) {
        this.logger.error(`Failed to initialize TRON ${network} provider: ${error.message}`);
      }
    }

    // Initialize XRP provider
    const xrpNetworks = {
      mainnet: this.configService.get('XRP_MAINNET_RPC'),
      testnet: this.configService.get('XRP_TESTNET_RPC'),
    };

    for (const [network, rpcUrl] of Object.entries(xrpNetworks)) {
      const providerKey = `xrp_${network}`;
      try {
        const provider = new Client(rpcUrl);
        await provider.connect();
        const info = await provider.request({
          command: 'server_info'
        });
        this.providers.set(providerKey, provider);
        this.logger.log(`XRP ${network} provider initialized successfully, current block: ${info.result.info.validated_ledger.seq}`);
      } catch (error) {
        this.logger.error(`Failed to initialize XRP ${network} provider: ${error.message}`);
      }
    }
  }

  private async startMonitoring() {
    await Promise.all([
      this.monitorEvmChains(),
      this.monitorBitcoin(),
      this.monitorTron(),
      this.monitorXrp(),
    ]);
  }

  private async monitorEvmChains() {
    try {
    for (const [providerKey, provider] of this.providers.entries()) {
      const [chain, network] = providerKey.split('_');
      if (['eth', 'bsc'].includes(chain)) {
        this.logger.log(`Started monitoring ${chain.toUpperCase()} ${network} blocks`);
          
          // Add block to queue when received
        provider.on('block', async (blockNumber: number) => {
            const queueKey = `${chain}_${network}`;
            this.blockQueues[queueKey].queue.push(blockNumber);
            this.processQueueForChain(chain, network, provider);
          });
        }
      }
    } catch (error) {
      this.logger.error(`Error in EVM chain monitor: ${error.message}`);
    }
  }

  private async processQueueForChain(chain: string, network: string, provider: any) {
    const queueKey = `${chain}_${network}`;
    const queue = this.blockQueues[queueKey];

    // If already processing, return
    if (queue.isProcessing) return;

    try {
        queue.isProcessing = true;

        while (queue.queue.length > 0) {
            const blockNumber = queue.queue.shift()!;
            try {
                await this.processEvmBlock(chain, network, blockNumber, provider);
                // Add delay between blocks
                await new Promise(resolve => setTimeout(resolve, this.PROCESSING_DELAYS[chain].blockDelay));
            } catch (error) {
                this.logger.error(`Error processing ${chain} ${network} block ${blockNumber}: ${error.message}`);
                // Continue with next block even if current fails
            }
        }
    } finally {
        queue.isProcessing = false;
        
        // Check if new blocks were added while processing
        if (queue.queue.length > 0) {
            this.processQueueForChain(chain, network, provider);
        }
    }
  }

  private async processEvmBlock(chain: string, network: string, blockNumber: number, provider: providers.Provider) {
    try {
        this.logger.debug(`Starting to process ${chain} ${network} block ${blockNumber}`);

      const block = await provider.getBlock(blockNumber);
        if (!block) {
            this.logger.warn(`${chain} ${network}: Block ${blockNumber} not found`);
            return;
        }

        this.logger.log(`${chain} ${network}: Processing block ${blockNumber} with ${block.transactions.length} transactions`);

        // Process transactions with retry logic
      for (const txHash of block.transactions) {
        try {
                const tx = await this.getEvmTransactionWithRetry(provider, txHash);
          if (tx) {
            await this.processEvmTransaction(chain, network, tx);
          }
        } catch (error) {
          this.logger.error(`Error processing transaction ${txHash}: ${error.message}`);
                // Continue processing other transactions
                continue;
            }
        }

        // Save progress
        try {
            await this.saveLastProcessedBlock(chain, network, blockNumber);
            const savedBlock = await this.getLastProcessedBlock(chain, network);
            this.logger.debug(`${chain} ${network}: Verified saved block ${savedBlock}`);
            this.logger.log(`${chain} ${network}: Completed block ${blockNumber}`);
      } catch (error) {
            this.logger.error(`Error saving progress for ${chain} ${network} block ${blockNumber}: ${error.message}`);
        throw error;
      }
    } catch (error) {
        this.logger.error(`Error processing ${chain} ${network} block ${blockNumber}: ${error.message}`);
        if (process.env.NODE_ENV === 'development') {
      this.logger.error(error.stack);
        }
        throw error;
    }
  }

  private async updateEvmConfirmations(chain: string, network: string, currentBlock: number) {
    try {
      const chainKey = this.CHAIN_KEYS[chain] || chain;
      const deposits = await this.depositRepository.find({
        where: {
          blockchain: chain,
          network: network,
          status: In(['pending', 'confirming']),
          blockNumber: Not(IsNull()),
        },
      });

      for (const deposit of deposits) {
        const confirmations = currentBlock - deposit.blockNumber;
        const requiredConfirmations = this.CONFIRMATION_BLOCKS[chainKey][network];

        await this.depositRepository.update(deposit.id, {
          confirmations,
          status: confirmations >= requiredConfirmations ? 'confirmed' : 'confirming'
        });

        if (confirmations >= requiredConfirmations && deposit.status !== 'confirmed') {
          await this.updateWalletBalance(deposit);
        }
      }
    } catch (error) {
      this.logger.error(`Error updating ${chain} confirmations: ${error.message}`);
    }
  }

  private async processEvmTransaction(
    chain: string,
    network: string,
    tx: providers.TransactionResponse
  ) {
    try {
      // Get all user wallets for this chain/network
      const wallets = await this.walletRepository.find({
        where: {
          blockchain: chain,
          network: network,
        },
      });

      // Create a map of addresses to wallet IDs for quick lookup
      const walletMap = new Map(wallets.map(w => [w.address.toLowerCase(), w]));

      // Check if transaction is to one of our wallets
      const toAddress = tx.to?.toLowerCase();
      if (!toAddress || !walletMap.has(toAddress)) return;

      const wallet = walletMap.get(toAddress);
      
      // Get token for this transaction
      const token = await this.getTokenForTransaction(chain, tx);
      if (!token) return;

      // Get amount based on token type
      const amount = await this.getTransactionAmount(tx, token);
      if (!amount) return;

      // Create deposit record
      await this.depositRepository.save({
        userId: wallet.userId,
        walletId: wallet.id,
        tokenId: token.id,
        txHash: tx.hash,
        amount: amount,
        blockchain: chain,
        network: network,
        networkVersion: token.networkVersion,
        blockNumber: tx.blockNumber,
        status: 'pending',
        metadata: {
          from: tx.from,
          contractAddress: token.contractAddress,
          blockHash: tx.blockHash,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        confirmations: 0
      });

    } catch (error) {
      this.logger.error(`Error processing transaction ${tx.hash}: ${error.message}`);
    }
  }

  private async getTokenForTransaction(chain: string, tx: providers.TransactionResponse): Promise<Token | null> {
    try {
      if (!tx.to) return null;

      // For native token transfers
      if (!tx.data || tx.data === '0x') {
        return this.tokenRepository.findOne({
          where: {
            blockchain: chain,
            networkVersion: 'NATIVE',
            isActive: true
          }
        });
      }

      // For token transfers
      return this.tokenRepository.findOne({
        where: {
          blockchain: chain,
          contractAddress: tx.to.toLowerCase(),
          isActive: true
        }
      });

    } catch (error) {
      this.logger.error(`Error getting token for tx ${tx.hash}: ${error.message}`);
      return null;
    }
  }

  private async getTransactionAmount(tx: providers.TransactionResponse, token: Token): Promise<string | null> {
    try {
      // Get provider based on blockchain and network from token metadata
      const networkType = token.metadata?.networks?.[0] || 'mainnet';
      const provider = this.providers.get(`${token.blockchain}_${networkType}`);
      
      // For native token transfers
      if (token.networkVersion === 'NATIVE') {
        return utils.formatUnits(tx.value, token.decimals);
      }

      // For token transfers
      const contract = new Contract(token.contractAddress, ERC20_ABI, provider);
      const transferEvent = (await tx.wait())?.logs
        .find(log => {
          try {
            return contract.interface.parseLog(log)?.name === 'Transfer';
          } catch {
            return false;
          }
        });

      if (!transferEvent) return null;

      const parsedLog = contract.interface.parseLog(transferEvent);
      return utils.formatUnits(parsedLog.args.value, token.decimals);

    } catch (error) {
      this.logger.error(`Error getting amount for tx ${tx.hash}: ${error.message}`);
      return null;
    }
  }

  private async updateWalletBalance(deposit: Deposit) {
    // Start transaction
    await this.walletBalanceRepository.manager.transaction(async manager => {
      // Get token first
      const token = await manager.findOne(Token, {
        where: { id: deposit.tokenId }
      });

      // Get wallet balance
      const balance = await manager.findOne(WalletBalance, {
        where: {
          userId: deposit.userId,
          baseSymbol: token.baseSymbol || token.symbol,
          type: 'spot'
        }
      });

      if (!balance) {
        throw new Error('Wallet balance not found');
      }

      // Update balance
      balance.balance = new Decimal(balance.balance)
        .plus(deposit.amount)
        .toString();

      await manager.save(balance);
    });
  }

  private async monitorBitcoin() {
    for (const network of ['mainnet', 'testnet']) {
      const provider = this.providers.get(`btc_${network}`);
      this.logger.log(`Started monitoring Bitcoin ${network} blocks`);
      
      setInterval(async () => {
        await this.checkBitcoinBlocks(network);
      }, this.PROCESSING_DELAYS.bitcoin.checkInterval);
    }
  }

  private async checkBitcoinBlocks(network: string) {
    try {
      const chain = 'bitcoin';
      const provider = this.providers.get(`btc_${network}`) as BitcoinProvider;
      if (!provider) {
        this.logger.warn(`No Bitcoin provider found for network ${network}`);
        return;
      }

      const currentHeight = await this.getBitcoinBlockHeight(provider);
      const lastProcessedBlock = await this.getLastProcessedBlock(chain, network);

      this.logger.log(`Bitcoin ${network}: Processing from block ${lastProcessedBlock + 1} to ${currentHeight}`);

      // Process blocks in batches
      const batchSize = 50;
      for (let height = lastProcessedBlock + 1; height <= currentHeight; height += batchSize) {
        const endBlock = Math.min(height + batchSize - 1, currentHeight);
        
        this.logger.log(`Bitcoin ${network}: Processing batch from block ${height} to ${endBlock}`);

        for (let blockNum = height; blockNum <= endBlock; blockNum++) {
          const block = await this.getBitcoinBlock(provider, blockNum);
          if (!block) {
            this.logger.warn(`Bitcoin ${network}: Block ${blockNum} not found`);
            continue;
          }

          await this.processBitcoinBlock(chain, network, block);
          this.logger.log(`Bitcoin ${network}: Completed block ${blockNum}`);
        }

        this.logger.log(`Bitcoin ${network}: Completed batch processing up to block ${endBlock}`);
      }
    } catch (error) {
      this.logger.error(`Error in Bitcoin block check: ${error.message}`);
      throw error;
    }
  }

  private async processBitcoinBlock(chain: string, network: string, block: BitcoinBlock) {
    // this.logger.debug(`Received block data: ${JSON.stringify(block, null, 2)}`);
    
    if (!block || !block.tx) {
        this.logger.warn(`Skipping invalid Bitcoin block for ${chain} ${network}: ${JSON.stringify(block)}`);
        return;
    }

    try {
        this.logger.log(`${chain} ${network}: Processing block ${block.height} with ${block.tx.length} transactions`);
        
        // Process transactions
    for (const tx of block.tx) {
            await this.processBitcoinTransaction(chain, network, tx);
        }

        // Save progress using btc prefix
        await this.saveLastProcessedBlock(chain, network, block.height);
        
        const savedBlock = await this.getLastProcessedBlock(chain, network);
        this.logger.debug(`${chain} ${network}: Verified saved block ${savedBlock}`);
        
        this.logger.log(`${chain} ${network}: Completed block ${block.height}`);
    } catch (error) {
        this.logger.error(`Error processing ${chain} ${network} block ${block.height}: ${error.message}`);
        throw error;
    }
  }

  private async bitcoinRpcCall(provider: any, method: string, params: any[]) {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // No need for Authorization header with QuickNode
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }

  private async getBitcoinTokenId(): Promise<string> {
    const token = await this.tokenRepository.findOne({
      where: {
        symbol: 'BTC',
        networkVersion: 'NATIVE'
      }
    });
    
    if (!token) {
      throw new Error('Bitcoin token not found in database');
    }
    
    return token.id.toString();
  }

  private async getBitcoinBlockHeight(provider: BitcoinProvider): Promise<number> {
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${provider.auth.username}:${provider.auth.password}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getblockcount',
          params: [],
          id: 1
        })
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(`Bitcoin RPC error: ${data.error.message}`);
      }

      return data.result;
    } catch (error) {
      this.logger.error(`Error getting Bitcoin block height: ${error.message}`);
      throw error;
    }
  }

  private async getBitcoinBlock(provider: BitcoinProvider, blockNumber: number): Promise<BitcoinBlock> {
    try {
      // First get block hash
      const hashResponse = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${provider.auth.username}:${provider.auth.password}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getblockhash',
          params: [blockNumber],
          id: 1
        })
      });

      const hashData = await hashResponse.json();
      if (hashData.error) {
        throw new Error(`Bitcoin RPC error: ${hashData.error.message}`);
      }

      // Then get block details
      const blockResponse = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${provider.auth.username}:${provider.auth.password}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getblock',
          params: [hashData.result, 2], // Verbosity level 2 for full transaction details
          id: 1
        })
      });

      const blockData = await blockResponse.json();
      if (blockData.error) {
        throw new Error(`Bitcoin RPC error: ${blockData.error.message}`);
      }

      return blockData.result;
    } catch (error) {
      this.logger.error(`Error getting Bitcoin block ${blockNumber}: ${error.message}`);
      throw error;
    }
  }

  private async getLastProcessedBlock(chain: string, network: string): Promise<number> {
    const chainKey = chain.toLowerCase() === 'bitcoin' ? 'btc' : chain.toLowerCase();
    const key = `last_processed_block_${chainKey}_${network}`;
    
    const setting = await this.systemSettingsRepository.findOne({ where: { key } });
    return setting ? parseInt(setting.value) : 0;
  }

  private getChainKey(blockchain: string): string {
    return this.CHAIN_KEYS[blockchain] || blockchain;
  }

  private async saveLastProcessedBlock(chain: string, network: string, blockNumber: number) {
    const chainKey = chain.toLowerCase() === 'bitcoin' ? 'btc' : chain.toLowerCase();
      const key = `last_processed_block_${chainKey}_${network}`;
      
    try {
      this.logger.debug(`Attempting to save with key: ${key}, value: ${blockNumber}`);
      
        // Use raw query for debugging
        await this.systemSettingsRepository.query(
            `INSERT INTO system_settings (key, value, "createdAt", "updatedAt") 
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (key) DO UPDATE 
             SET value = $2, "updatedAt" = NOW()`,
        [key, blockNumber.toString()]
      );
      
      this.logger.log(`Saved last processed block for ${chainKey} ${network}: ${blockNumber}`);
        
        // Verify the save
        const saved = await this.systemSettingsRepository.findOne({ where: { key } });
        if (saved && parseInt(saved.value) === blockNumber) {
            this.logger.debug(`${chainKey} ${network} Debug - Block ${blockNumber} saved successfully. Verified value: ${saved.value}`);
        } else {
            this.logger.error(`Failed to verify saved block for ${chainKey} ${network}. Expected: ${blockNumber}, Got: ${saved?.value}`);
            throw new Error(`Block save verification failed for ${chainKey} ${network}`);
        }
    } catch (error) {
        this.logger.error(`Error saving last processed block for ${chainKey} ${network}: ${error.message}`);
        throw error;
    }
  }

  // Add retry logic for EVM transaction fetching
  private async getEvmTransactionWithRetry(provider: providers.Provider, txHash: string, retries = 3): Promise<providers.TransactionResponse | null> {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await provider.getTransaction(txHash);
            return tx;
        } catch (error) {
            if (i === retries - 1) {
                throw error;
            }
            // Wait before retry, increasing delay each time
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    return null;
  }

  private async monitorTron() {
    for (const network of ['mainnet', 'testnet']) {
      const tronWeb = this.providers.get(`trx_${network}`) as TronWebInstance;
      if (!tronWeb) continue;
      
      this.logger.log(`Started monitoring TRON ${network} blocks`);
      
      setInterval(async () => {
        await this.checkTronBlocks(network, tronWeb);
      }, this.PROCESSING_DELAYS.trx.checkInterval);
    }
  }

  private async checkTronBlocks(network: string, tronWeb: TronWebInstance) {
    try {
      const currentBlock = await tronWeb.trx.getCurrentBlock();
      const lastProcessedBlock = await this.getLastProcessedBlock('trx', network);
      const currentBlockNumber = currentBlock.block_header.raw_data.number;

      this.logger.log(`TRON ${network}: Processing blocks from ${lastProcessedBlock + 1} to ${currentBlockNumber}`);

      // Process blocks in smaller batches to avoid rate limits
      const batchSize = 5;
      const startBlock = lastProcessedBlock + 1;
      const endBlock = Math.min(startBlock + batchSize, currentBlockNumber);

      this.logger.log(`TRON ${network}: Processing batch from block ${startBlock} to ${endBlock}`);

      for (let height = startBlock; height <= endBlock; height++) {
        try {
          this.logger.log(`TRON ${network}: Processing block ${height}`);
          
          // Add configurable delay between blocks
          await new Promise(resolve => setTimeout(resolve, this.PROCESSING_DELAYS.trx.blockDelay));

          // Get block with retry logic
          const block = await this.getTronBlockWithRetry(tronWeb, height, 3);
          if (!block) {
            this.logger.warn(`Skipping TRON ${network} block ${height}: Could not fetch block data`);
            continue;
          }

          // Log transactions found
          const txCount = block.transactions?.length || 0;
          this.logger.log(`TRON ${network}: Block ${height} has ${txCount} transactions`);

          await this.processTronBlock(network, block);
          await this.updateTronConfirmations(network, height);
          await this.saveLastProcessedBlock('trx', network, height);

          this.logger.log(`TRON ${network}: Successfully processed block ${height}`);

        } catch (error) {
          if (error.response?.status === 403) {
            this.logger.error(`TRON API rate limit reached at block ${height}, waiting longer...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          this.logger.error(`Error processing TRON block ${height}: ${error.message}`);
        }
      }

      this.logger.log(`TRON ${network}: Completed processing batch of blocks`);
    } catch (error) {
      this.logger.error(`Error in TRON block check: ${error.message}`);
    }
  }

  private async getTronBlockWithRetry(
    tronWeb: TronWebInstance, 
    height: number, 
    maxRetries: number
  ): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const block = await tronWeb.trx.getBlock(height);
        return block;
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
      }
    }
    return null;
  }

  private async processTronBlock(network: string, block: any) {
    try {
      // Get all TRON wallets
      const wallets = await this.walletRepository.find({
        where: {
          blockchain: 'trx',
          network,
        },
      });

      const walletAddresses = new Set(wallets.map(w => w.address));
      const tronWeb = this.providers.get(`trx_${network}`) as TronWebInstance;

      // Process each transaction
      for (const tx of block.transactions || []) {
        if (tx.raw_data?.contract?.[0]?.type === 'TransferContract' || 
            tx.raw_data?.contract?.[0]?.type === 'TransferAssetContract') {
          
          const contract = tx.raw_data.contract[0];
          const parameter = contract.parameter.value;
          const toAddress = tronWeb.address.fromHex(parameter.to_address);

          if (walletAddresses.has(toAddress)) {
            const wallet = wallets.find(w => w.address === toAddress);
            const token = await this.getTronToken(contract.type, parameter.asset_name);

            if (token) {
              await this.depositRepository.save({
                userId: wallet.userId,
                walletId: wallet.id,
                tokenId: token.id,
                txHash: tx.txID,
                amount: (parameter.amount / Math.pow(10, token.decimals)).toString(),
                blockchain: 'trx',
                network,
                networkVersion: token.networkVersion,
                blockNumber: block.block_header.raw_data.number,
                status: 'pending',
                metadata: {
                  from: tronWeb.address.fromHex(parameter.owner_address),
                  contractAddress: token.contractAddress,
                  blockHash: block.blockID,
                },
                createdAt: new Date(),
                updatedAt: new Date(),
                confirmations: 0
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing TRON block: ${error.message}`);
    }
  }

  private async updateTronConfirmations(network: string, currentBlock: number) {
    try {
      const deposits = await this.depositRepository.find({
        where: {
          blockchain: 'trx',
          network,
          status: In(['pending', 'confirming']),
          blockNumber: Not(IsNull()),
        },
      });

      for (const deposit of deposits) {
        const confirmations = currentBlock - deposit.blockNumber;
        const requiredConfirmations = this.CONFIRMATION_BLOCKS.trx[network];

        await this.depositRepository.update(deposit.id, {
          confirmations,
          status: confirmations >= requiredConfirmations ? 'confirmed' : 'confirming'
        });

        if (confirmations >= requiredConfirmations && deposit.status !== 'confirmed') {
          await this.updateWalletBalance(deposit);
        }
      }
    } catch (error) {
      this.logger.error(`Error updating TRON confirmations: ${error.message}`);
    }
  }

  private async getTronToken(contractType: string, assetName?: string): Promise<Token | null> {
    if (contractType === 'TransferContract') {
      return this.tokenRepository.findOne({
        where: {
          blockchain: 'trx',
          networkVersion: 'NATIVE',
          isActive: true
        }
      });
    }

    if (contractType === 'TransferAssetContract' && assetName) {
      return this.tokenRepository.findOne({
        where: {
          blockchain: 'trx',
          networkVersion: 'TRC20',
          symbol: assetName,
          isActive: true
        }
      });
    }

    return null;
  }

  public async testConnection(chain: string) {
    try {
      switch (chain) {
        case 'ethereum':
        case 'bsc': {
          const provider = this.providers.get(`${chain}_mainnet`) as JsonRpcProvider;
          const blockNumber = await provider.getBlockNumber();
          return { blockNumber, network: 'mainnet' };
        }
        
        case 'bitcoin': {
          const provider = this.providers.get('btc_mainnet');
          const blockCount = await this.bitcoinRpcCall(provider, 'getblockcount', []);
          return { blockNumber: blockCount, network: 'mainnet' };
        }
        
        case 'trx': {
          const tronWeb = this.providers.get('trx_mainnet') as TronWebInstance;
          const block = await tronWeb.trx.getCurrentBlock();
          return { 
            blockNumber: block.block_header.raw_data.number,
            network: 'mainnet'
          };
        }
        
        default:
          throw new Error(`Unsupported chain: ${chain}`);
      }
    } catch (error) {
      this.logger.error(`Error testing ${chain} connection: ${error.message}`);
      throw error;
    }
  }

  // Add this method to process Bitcoin transactions
  private async processBitcoinTransaction(chain: string, network: string, tx: any) {
    try {
        // Get all Bitcoin wallets
        const wallets = await this.walletRepository.find({
            where: {
                blockchain: chain,
                network: network,
            },
        });

        const walletAddresses = new Set(wallets.map(w => w.address));

        // Process each output
        for (const output of tx.vout) {
            const addresses = output.scriptPubKey.addresses || [];
            
            for (const address of addresses) {
                if (walletAddresses.has(address)) {
                    const wallet = wallets.find(w => w.address === address);
                    if (!wallet) continue;

                    const tokenId = await this.getBitcoinTokenId();
                    
                    // Create deposit record with correct types
                    await this.depositRepository.save({
                        userId: wallet.userId.toString(), // Convert to string if needed
                        walletId: wallet.id.toString(), // Convert to string if needed
                        tokenId: tokenId.toString(), // Convert to string as per entity definition
                        txHash: tx.txid,
                        amount: output.value.toString(),
                        blockchain: chain,
                        network: network,
                        networkVersion: 'NATIVE',
                        blockNumber: tx.blockHeight,
                        status: 'pending',
                        metadata: {
                            from: tx.vin[0]?.scriptSig?.addresses?.[0] || 'unknown',
                            blockHash: tx.blockHash,
                        },
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        confirmations: 0
                    });

                    this.logger.debug(`Created deposit record for Bitcoin transaction ${tx.txid} to address ${address}`);
                }
            }
        }
    } catch (error) {
        this.logger.error(`Error processing Bitcoin transaction: ${error.message}`);
      throw error;
    }
  }

  private async monitorXrp() {
    for (const network of ['mainnet', 'testnet']) {
      const provider = this.providers.get(`xrp_${network}`);
      if (!provider) continue;
      
      this.logger.log(`Started monitoring XRP ${network} blocks`);
      
      setInterval(async () => {
        await this.checkXrpBlocks(network);
      }, this.PROCESSING_DELAYS.xrp.checkInterval);
    }
  }

  private async checkXrpBlocks(network: string) {
    try {
        const provider = this.providers.get(`xrp_${network}`) as Client;
        if (!provider) {
            this.logger.warn(`No XRP provider found for network ${network}`);
            return;
        }

        // Get current ledger using server_info command
        const serverInfo = await provider.request({
            command: 'server_info'
        });
        const currentLedger = serverInfo.result.info.validated_ledger.seq;
        const lastProcessedBlock = await this.getLastProcessedBlock('xrp', network);

        this.logger.log(`XRP ${network}: Processing from ledger ${lastProcessedBlock + 1} to ${currentLedger}`);

        for (let ledgerIndex = lastProcessedBlock + 1; ledgerIndex <= currentLedger; ledgerIndex++) {
            await this.processXrpLedger('xrp', network, ledgerIndex);
            await this.saveLastProcessedBlock('xrp', network, ledgerIndex);
        }
    } catch (error) {
        this.logger.error(`Error in XRP block check: ${error.message}`);
    }
  }

  private async processXrpLedger(chain: string, network: string, ledgerIndex: number) {
    try {
        const provider = this.providers.get(`xrp_${network}`) as Client;
        
        // Get ledger with transactions
        const ledgerResponse = await provider.request({
            command: 'ledger',
            ledger_index: ledgerIndex,
            transactions: true,
            expand: true
        });
        
        const transactions = ledgerResponse.result.ledger.transactions || [];
        this.logger.log(`XRP ${network}: Processing ledger ${ledgerIndex} with ${transactions.length} transactions`);

        for (const tx of transactions) {
            await this.processXrpTransaction(chain, network, tx);
        }

        this.logger.log(`XRP ${network}: Completed ledger ${ledgerIndex}`);
    } catch (error) {
        this.logger.error(`Error processing XRP ledger ${ledgerIndex}: ${error.message}`);
    }
  }

  private async processXrpTransaction(chain: string, network: string, tx: any) {
    try {
      if (tx.TransactionType !== 'Payment') return;

      const wallets = await this.walletRepository.find({
        where: {
          blockchain: chain,
          network: network,
        },
      });

      const walletAddresses = new Set(wallets.map(w => w.address));

      if (walletAddresses.has(tx.Destination)) {
        const wallet = wallets.find(w => w.address === tx.Destination);
        if (!wallet) return;

        const tokenId = await this.getXrpTokenId();

        await this.depositRepository.save({
          userId: wallet.userId.toString(),
          walletId: wallet.id.toString(),
          tokenId: tokenId.toString(),
          txHash: tx.hash,
          amount: tx.Amount,
          blockchain: chain,
          network: network,
          networkVersion: 'NATIVE',
          blockNumber: tx.ledger_index,
          status: 'pending',
          metadata: {
            from: tx.Account,
            blockHash: tx.ledger_hash,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          confirmations: 0
        });
      }
    } catch (error) {
      this.logger.error(`Error processing XRP transaction: ${error.message}`);
    }
  }

  private async getXrpTokenId(): Promise<string> {
    const token = await this.tokenRepository.findOne({
      where: {
        symbol: 'XRP',
        networkVersion: 'NATIVE'
      }
    });
    
    if (!token) {
      throw new Error('XRP token not found in database');
    }
    
    return token.id.toString();
  }
}