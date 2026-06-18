import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

// DeepBook Predict on-chain constants (testnet)
export const PREDICT_PACKAGE =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
export const PREDICT_ID =
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
export const DUSDC_TYPE =
  "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC";
export const CLOCK_ID = "0x6";

/**
 * Deposit DUSDC into a PredictManager.
 * @param managerId  the user's PredictManager (shared object)
 * @param coinObjectId  a DUSDC coin object owned by the user
 * @param amount  amount in DUSDC base units (1e6 = $1)
 */
export function buildDepositTx(params: {
  managerId: string;
  amount: bigint; // DUSDC base units (1e6 = $1)
}): Transaction {
  const tx = new Transaction();

  // coinWithBalance auto-selects & merges/splits the user's DUSDC coins
  // to produce exactly `amount` of DUSDC for this transaction.
  const depositCoin = coinWithBalance({
    type: DUSDC_TYPE,
    balance: params.amount,
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict_manager::deposit`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(params.managerId), depositCoin],
  });

  return tx;
}

/**
 * Build a mint (bet) transaction.
 * 2-step PTB: market_key::up|down -> predict::mint
 */
export function buildMintTx(params: {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  strike: bigint; // 1e9-scaled strike
  isUp: boolean;
  quantity: bigint; // 1e6-scaled quantity ($ amount * 1e6)
}): Transaction {
  const tx = new Transaction();

  const direction = params.isUp ? "up" : "down";
  const marketKey = tx.moveCall({
    target: `${PREDICT_PACKAGE}::market_key::${direction}`,
    arguments: [
      tx.pure.id(params.oracleId),
      tx.pure.u64(params.expiry),
      tx.pure.u64(params.strike),
    ],
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      marketKey,
      tx.pure.u64(params.quantity),
      tx.object(CLOCK_ID),
    ],
  });

  return tx;
}

/**
 * Mint a RANGE position: bet that the price settles between lower and higher.
 * Uses predict::mint_range directly (same path as buildMintTx for binary).
 * @param lowerStrike  lower bound, 1e9-scaled
 * @param higherStrike higher bound, 1e9-scaled (must be > lowerStrike)
 */
export function buildRangeMintTx(params: {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  lowerStrike: bigint; // 1e9-scaled
  higherStrike: bigint; // 1e9-scaled
  quantity: bigint; // 1e6-scaled
}): Transaction {
  const tx = new Transaction();

  const rangeKey = tx.moveCall({
    target: `${PREDICT_PACKAGE}::range_key::new`,
    arguments: [
      tx.pure.id(params.oracleId),
      tx.pure.u64(params.expiry),
      tx.pure.u64(params.lowerStrike),
      tx.pure.u64(params.higherStrike),
    ],
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::mint_range`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      rangeKey,
      tx.pure.u64(params.quantity),
      tx.object(CLOCK_ID),
    ],
  });

  return tx;
}

/**
 * Redeem (close) a binary position. Before settlement this pays the live bid
 * (early exit / take-profit); after settlement it pays $1·qty if it won, else $0.
 */
export function buildRedeemTx(params: {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  strike: bigint;
  isUp: boolean;
  quantity: bigint;
}): Transaction {
  const tx = new Transaction();
  const direction = params.isUp ? "up" : "down";
  const marketKey = tx.moveCall({
    target: `${PREDICT_PACKAGE}::market_key::${direction}`,
    arguments: [
      tx.pure.id(params.oracleId),
      tx.pure.u64(params.expiry),
      tx.pure.u64(params.strike),
    ],
  });
  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::redeem`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      marketKey,
      tx.pure.u64(params.quantity),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/**
 * Redeem (close) a range position. Same early-exit semantics as buildRedeemTx.
 */
export function buildRedeemRangeTx(params: {
  managerId: string;
  oracleId: string;
  expiry: bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
  quantity: bigint;
}): Transaction {
  const tx = new Transaction();
  const rangeKey = tx.moveCall({
    target: `${PREDICT_PACKAGE}::range_key::new`,
    arguments: [
      tx.pure.id(params.oracleId),
      tx.pure.u64(params.expiry),
      tx.pure.u64(params.lowerStrike),
      tx.pure.u64(params.higherStrike),
    ],
  });
  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::redeem_range`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      rangeKey,
      tx.pure.u64(params.quantity),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}
