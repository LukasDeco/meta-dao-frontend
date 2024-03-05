import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { AccountInfo, AccountMeta, Context, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { notifications } from '@mantine/notifications';
import {
    MarketAccountWithKey,
    Markets,
    OrderBook,
    Proposal,
    ProposalAccountWithKey,
} from '@/lib/types';
import { useAutocrat } from '@/contexts/AutocratContext';
import { useConditionalVault } from '@/hooks/useConditionalVault';
import { useOpenbookTwap } from '@/hooks/useOpenbookTwap';
import { useTransactionSender } from '@/hooks/useTransactionSender';
import { findOpenOrders, findOpenOrdersIndexer, getLeafNodes } from '../lib/openbook';
import { debounce } from '../lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { BN, Program } from '@coral-xyz/anchor';
import { AnyNode, LeafNode, OpenbookV2, IDL as OPENBOOK_IDL, OPENBOOK_PROGRAM_ID } from '@openbook-dex/openbook-v2';
import { useProvider } from '@/hooks/useProvider';

export type OrderBookOrder = {
    price: number;
    size: number;
    timestamp: BN;
    owner: PublicKey;
    ownerSlot: number;
    side: "bids" | "asks";
    market: PublicKey;
    clientOrderId: number;
};

export interface ProposalInterface {
    markets?: Markets;
    orders?: OrderBookOrder[];
    passAsks?: any[][];
    passBids?: any[][];
    failAsks?: any[][];
    failBids?: any[][];
    orderBookObject?: OrderBook;
    loading?: boolean;
    passSpreadString: string;
    failSpreadString: string;
    lastPassSlotUpdated: number;
    lastFailSlotUpdated: number;
    fetchMarketsInfo: () => Promise<void>;
    fetchOpenOrders: (args_0: PublicKey) => Promise<void>;
    placeOrderTransactions: (
        amount: number,
        price: number,
        market: MarketAccountWithKey,
        limitOrder?: boolean | undefined,
        ask?: boolean | undefined,
        pass?: boolean | undefined,
        indexOffset?: number | undefined,
    ) => Promise<any>;
    placeOrder: (
        amount: number,
        price: number,
        limitOrder?: boolean,
        ask?: boolean,
        pass?: boolean,
    ) => Promise<void>;
}

export const OrdersContext = createContext<ProposalInterface | undefined>(undefined);

export const useOrders = () => {
    const context = useContext(OrdersContext);
    if (!context) {
        throw new Error('useOrders must be used within a OrdersContextProvider');
    }
    return context;
};



export function OrdersProvider({
    children,
    proposalNumber,
    fromProposal,
}: {
    children: React.ReactNode;
    proposalNumber?: number | undefined;
    fromProposal?: ProposalAccountWithKey;
}) {
    const provider = useProvider();
    const openBookProgram = new Program<OpenbookV2>(OPENBOOK_IDL, OPENBOOK_PROGRAM_ID, provider);
    const client = useQueryClient();
    const { openbook, openbookTwap, proposals } =
        useAutocrat();
    const { connection } = useConnection();
    const wallet = useWallet();
    const sender = useTransactionSender();
    const { placeOrderTransactions } = useOpenbookTwap();
    const {
        program: vaultProgram,
    } = useConditionalVault();
    const [loading, setLoading] = useState(false);
    const [markets, setMarkets] = useState<Markets>();
    const [orders, setOrders] = useState<OrderBookOrder[]>([]);
    const [passBids, setPassBids] = useState<any[][]>([]);
    const [passAsks, setPassAsks] = useState<any[][]>([]);
    const [failBids, setFailBids] = useState<any[][]>([]);
    const [failAsks, setFailAsks] = useState<any[][]>([]);
    const [wsConnected, setWsConnected] = useState<boolean>(false);
    const [passSpreadString, setPassSpreadString] = useState<string>("");
    const [failSpreadString, setFailSpreadString] = useState<string>("");
    const [lastPassSlotUpdated, setLastPassSlotUpdated] = useState<number>(0);
    const [lastFailSlotUpdated, setLastFailSlotUpdated] = useState<number>(0);

    const proposal = useMemo<Proposal | undefined>(
        () =>
            proposals?.filter(
                (t) =>
                    t.account.number === proposalNumber ||
                    t.publicKey.toString() === fromProposal?.publicKey.toString(),
            )[0],
        [proposals, fromProposal, proposalNumber],
    );

    const fetchMarketsInfo = useCallback(
        debounce(async () => {
            const fetchProposalMarketsInfo = async () => {
                setLoading(true);
                if (!proposal || !openbook || !openbookTwap || !openbookTwap.views || !connection) {
                    return;
                }
                const accountInfos = await connection.getMultipleAccountsInfo([
                    proposal.account.openbookPassMarket,
                    proposal.account.openbookFailMarket,
                    proposal.account.openbookTwapPassMarket,
                    proposal.account.openbookTwapFailMarket,
                    proposal.account.baseVault,
                    proposal.account.quoteVault,
                ]);
                if (!accountInfos || accountInfos.indexOf(null) >= 0) return;

                const pass = await openbook.coder.accounts.decode('market', accountInfos[0]!.data);
                const fail = await openbook.coder.accounts.decode('market', accountInfos[1]!.data);
                const passTwap = await openbookTwap.coder.accounts.decodeUnchecked(
                    'TWAPMarket',
                    accountInfos[2]!.data,
                );
                const failTwap = await openbookTwap.coder.accounts.decodeUnchecked(
                    'TWAPMarket',
                    accountInfos[3]!.data,
                );
                const baseVault = await vaultProgram.coder.accounts.decode(
                    'conditionalVault',
                    accountInfos[4]!.data,
                );
                const quoteVault = await vaultProgram.coder.accounts.decode(
                    'conditionalVault',
                    accountInfos[5]!.data,
                );

                const bookAccountInfos = await connection.getMultipleAccountsInfo([
                    pass.asks,
                    pass.bids,
                    fail.asks,
                    fail.bids,
                ]);
                const passAsks = getLeafNodes(
                    await openbook.coder.accounts.decode('bookSide', bookAccountInfos[0]!.data),
                    openbook,
                );
                const passBids = getLeafNodes(
                    await openbook.coder.accounts.decode('bookSide', bookAccountInfos[1]!.data),
                    openbook,
                );
                const failAsks = getLeafNodes(
                    await openbook.coder.accounts.decode('bookSide', bookAccountInfos[2]!.data),
                    openbook,
                );
                const failBids = getLeafNodes(
                    await openbook.coder.accounts.decode('bookSide', bookAccountInfos[3]!.data),
                    openbook,
                );

                return {
                    pass,
                    passAsks,
                    passBids,
                    fail,
                    failAsks,
                    failBids,
                    passTwap,
                    failTwap,
                    baseVault,
                    quoteVault,
                };
            };

            const marketsInfo = await client.fetchQuery({
                queryKey: [`fetchProposalMarketsInfo-${proposal?.publicKey}`],
                queryFn: () => fetchProposalMarketsInfo(),
                staleTime: 10_000,
            });
            setMarkets(marketsInfo);
            setLoading(false);
        }, 1000),
        [vaultProgram, openbook, openbookTwap, proposal, connection],
    );

    useEffect(() => {
        setMarkets(undefined);
        fetchMarketsInfo();
    }, [proposal]);

    const fetchOpenOrders = useCallback(
        debounce<[PublicKey]>(async (owner: PublicKey) => {
            const fetchProposalOpenOrders = async () => {
                if (!openbook || !proposal) {
                    return;
                }
                const passOrders = await openbook.account.openOrdersAccount.all([
                    { memcmp: { offset: 8, bytes: owner.toBase58() } },
                    { memcmp: { offset: 40, bytes: proposal.account.openbookPassMarket.toBase58() } },
                ]);
                const failOrders = await openbook.account.openOrdersAccount.all([
                    { memcmp: { offset: 8, bytes: owner.toBase58() } },
                    { memcmp: { offset: 40, bytes: proposal.account.openbookFailMarket.toBase58() } },
                ]);
                return passOrders
                    .concat(failOrders)
                    .sort((a, b) => (a.account.accountNum < b.account.accountNum ? 1 : -1));
            };

            const orders = await client.fetchQuery({
                queryKey: [`fetchProposalOpenOrders-${proposal?.publicKey}`],
                queryFn: () => fetchProposalOpenOrders(),
                staleTime: 1_000,
            });
            console.log("direct fetching of orders");
            console.log(orders);
            orders?.forEach(o => {
                console.log("order direct fetched", o.account.owner.toString());
            });
        }, 1000),
        [openbook, proposal],
    );

    useEffect(() => {
        if (proposal && wallet.publicKey) {
            fetchOpenOrders(wallet.publicKey);
        }
    }, [markets, fetchOpenOrders, proposal]);

    useEffect(() => {
        if (!markets && proposal) {
            fetchMarketsInfo();
        }
    }, [markets, fetchMarketsInfo, proposal]);
    // useEffect(() => {
    //     if (markets && proposal) {
    //         const ordersForUser = [...markets.passAsks, ...markets.passBids, ...markets.failAsks, ...markets.failBids].filter(t => {
    //             t.owner == wallet.publicKey;
    //         }).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).map<Order>(e => {
    //             return {
    //                 price: e.key.shrn(64).toNumber(), // price
    //                 size: e.quantity.toNumber(), // size
    //                 publicKey: e.owner, //
    //                 index: e.ownerSlot,
    //                 // notional is price timez size
    //                 // bubble down for side.market
    //                 // accountInfo buffer has asks or bids
    //                 // findOpenOrdersIndexer wallet.publicKey to leafNode.owner or one of those variants
    //                 // status is interesting - if it's an order and it's on the order book, 
    //                 // if size is 0 than it's completed
    //                 // forget about partially filled
    //             };
    //         });
    //         setOrders(ordersForUser);
    //     }
    // }, [markets]);

    const orderBookObject = useMemo(() => {
        const getSide = (side: LeafNode[], isBidSide?: boolean) => {
            if (side.length === 0) {
                return null;
            }
            const parsed = side
                .map((e) => ({
                    price: e.key.shrn(64).toNumber(),
                    size: e.quantity.toNumber(),
                }))
                .sort((a, b) => a.price - b.price);

            const sorted = isBidSide
                ? parsed.sort((a, b) => b.price - a.price)
                : parsed.sort((a, b) => a.price - b.price);

            const deduped = new Map();
            sorted.forEach((order) => {
                if (deduped.get(order.price) === undefined) {
                    deduped.set(order.price, order.size);
                } else {
                    deduped.set(order.price, deduped.get(order.price) + order.size);
                }
            });

            const total = parsed.reduce((a, b) => ({
                price: a.price + b.price,
                size: a.size + b.size,
            }));
            return { parsed, total, deduped };
        };

        const orderBookSide = (orderBookForSide: LeafNode[], isBidSide?: boolean) => {
            if (orderBookForSide) {
                const _orderBookSide = getSide(orderBookForSide, isBidSide);
                if (_orderBookSide) {
                    return Array.from(_orderBookSide.deduped?.entries()).map((side) => [
                        (side[0] / 10_000).toFixed(4),
                        side[1],
                    ]);
                }
            }
            if (isBidSide) {
                return [[0, 0]];
            }
            return [[69, 0]];
        };

        const getToB = (bids: LeafNode[], asks: LeafNode[]) => {
            const _bids = orderBookSide(bids, true);
            const _asks = orderBookSide(asks);
            const tobAsk: number = Number(_asks[0][0]);
            const tobBid: number = Number(_bids[0][0]);
            return {
                topAsk: tobAsk,
                topBid: tobBid,
            };
        };

        const getSpreadString = (bids: LeafNode[], asks: LeafNode[]) => {
            const { topAsk, topBid } = getToB(bids, asks);
            const spread: number = topAsk - topBid;
            const spreadPercent: string = ((spread / topBid) * 100).toFixed(2);

            return spread === topAsk
                ? '∞ (100.00%)'
                : `${spread.toFixed(2).toString()} (${spreadPercent}%)`;
        };

        const getUsersOrders = (passBids: LeafNode[], passAsks: LeafNode[], failBids: LeafNode[], failAsks: LeafNode[]): OrderBookOrder[] => {
            if (wallet.publicKey) {
                const passBidOrders = passBids
                    .map((leafNode) => {
                        const size = leafNode.quantity.toNumber();
                        const price = leafNode.key.shrn(64).toNumber() / 10_000;
                        return {
                            price,
                            size,
                            market: proposal?.account.openbookPassMarket,
                            owner: leafNode.owner,
                            ownerSlot: leafNode.ownerSlot,
                            side: "bids" as const,
                            timestamp: leafNode.timestamp,
                            clientOrderId: leafNode.clientOrderId,
                        };
                    });
                const passAskOrders = passAsks
                    .map((leafNode) => {
                        const size = leafNode.quantity.toNumber();
                        const price = leafNode.key.shrn(64).toNumber() / 10_000;
                        return {
                            price,
                            size,
                            market: proposal?.account.openbookPassMarket,
                            owner: leafNode.owner,
                            ownerSlot: leafNode.ownerSlot,
                            side: "asks" as const,
                            timestamp: leafNode.timestamp,
                            clientOrderId: leafNode.clientOrderId,
                        };
                    });
                const failBidOrders = failBids
                    .map((leafNode) => {
                        const size = leafNode.quantity.toNumber();
                        const price = leafNode.key.shrn(64).toNumber() / 10_000;
                        return {
                            price,
                            size,
                            market: proposal?.account.openbookFailMarket,
                            owner: leafNode.owner,
                            ownerSlot: leafNode.ownerSlot,
                            side: "bids" as const,
                            timestamp: leafNode.timestamp,
                            clientOrderId: leafNode.clientOrderId,
                        };
                    });
                const failAskOrders = failAsks
                    .map((leafNode) => {
                        const size = leafNode.quantity.toNumber();
                        const price = leafNode.key.shrn(64).toNumber() / 10_000;
                        return {
                            price,
                            size,
                            market: proposal?.account.openbookFailMarket,
                            owner: leafNode.owner,
                            ownerSlot: leafNode.ownerSlot,
                            side: "asks" as const,
                            timestamp: leafNode.timestamp,
                            clientOrderId: leafNode.clientOrderId,
                        };
                    });
                const userOrderOwnerIndexer = findOpenOrdersIndexer(wallet.publicKey);
                const userOrderOwnerOpenOrders = findOpenOrders(new BN(3), wallet.publicKey);

                console.log("wallet.publicKey", wallet.publicKey.toString());
                console.log("userOrderOwnerIndexer.toString()", userOrderOwnerIndexer.toString());
                console.log("userOrderOwnerOpenOrders.toString()", userOrderOwnerOpenOrders.toString());

                return [...passBidOrders, ...passAskOrders, ...failBidOrders, ...failAskOrders].filter((o) => {
                    console.log("owner to filter", o.owner.toString());

                    return !!o.market && o.owner === userOrderOwnerIndexer;
                }) as OrderBookOrder[];
            }
            return [];

        };

        //get the leafNodesData which is one side's data

        if (markets) {
            const userOrders = getUsersOrders(markets.passBids, markets?.passAsks, markets.failBids, markets.failAsks);
            console.log("user orders!");
            console.log(userOrders);
            return {
                orders: userOrders,
                passBidsProcessed: getSide(markets.passBids, true),
                passAsksProcessed: getSide(markets.passAsks),
                passBidsArray: orderBookSide(markets.passBids, true),
                passAsksArray: orderBookSide(markets.passAsks),
                failBidsProcessed: getSide(markets.failBids, true),
                failAsksProcessed: getSide(markets.failAsks),
                failBidsArray: orderBookSide(markets.failBids, true),
                failAsksArray: orderBookSide(markets.failAsks),
                passToB: getToB(markets.passBids, markets.passAsks),
                failToB: getToB(markets.failBids, markets.failAsks),
                passSpreadString: getSpreadString(markets.passBids, markets.passAsks),
                failSpreadString: getSpreadString(markets.failBids, markets.failAsks),
            };
        }
        return undefined;
    }, [markets]);

    const placeOrder = useCallback(
        async (amount: number, price: number, limitOrder?: boolean, ask?: boolean, pass?: boolean) => {
            if (!proposal || !markets) return;
            const market = pass
                ? { publicKey: proposal?.account.openbookPassMarket, account: markets?.pass }
                : { publicKey: proposal?.account.openbookFailMarket, account: markets?.fail };
            const placeTxs = await placeOrderTransactions(amount, price, market, limitOrder, ask, pass);

            if (!placeTxs || !wallet.publicKey) {
                return;
            }

            try {
                setLoading(true);

                await sender.send(placeTxs);
                await fetchMarketsInfo();
                await fetchOpenOrders(wallet.publicKey);
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        },
        [
            wallet,
            proposal,
            markets,
            connection,
            sender,
            placeOrderTransactions,
            fetchMarketsInfo,
            // fetchOpenOrders,
        ],
    );


    const consumeOrderBookSide = (
        side: string,
        updatedAccountInfo: AccountInfo<Buffer>,
        market: PublicKey,
        ctx: Context,
    ) => {
        try {
            //TODO!!! check the updated data that flows through here 
            // and compare it to the new order that gets fetched to see how we can map things up;
            const isPassMarket = market == proposal?.account.openbookPassMarket;
            const leafNodes = openBookProgram.coder.accounts.decode('bookSide', updatedAccountInfo.data);
            const leafNodesData: AnyNode[] = leafNodes.nodes.nodes.filter(
                (x: AnyNode) => x.tag === 2,
            );


            // agh goddamn I ddi a sell on a fail and this didn't fire
            console.log("leafNodes");
            console.log(leafNodes);
            console.log("leafNodesData");
            console.log(leafNodesData);
            const _side: OrderBookOrder[] = leafNodesData
                .map((x) => {
                    const leafNode: LeafNode = openBookProgram.coder.types.decode(
                        'LeafNode',
                        Buffer.from([0, ...x.data]),
                    );
                    const size = leafNode.quantity.toNumber();
                    const price = leafNode.key.shrn(64).toNumber() / 10_000;
                    return {
                        price,
                        size,
                        market: market,
                        owner: leafNode.owner,
                        ownerSlot: leafNode.ownerSlot,
                        side: side === "asks" ? "asks" : "bids",
                        timestamp: leafNode.timestamp,
                        clientOrderId: leafNode.clientOrderId,
                    };
                });

            let sortedSide;
            console.log("_side");
            console.log(_side);

            if (side === 'asks') {
                // Ask side sort
                sortedSide = _side.sort((
                    a: { price: number, size: number; },
                    b: { price: number, size: number; }) => a.price - b.price);
            } else {
                // Bid side sort
                sortedSide = _side.sort((
                    a: { price: number, size: number; },
                    b: { price: number, size: number; }) => b.price - a.price);
            }

            // Aggregate the price levels into sum(size)
            const _aggreateSide = new Map();
            sortedSide.forEach((order: { price: number, size: number; }) => {
                if (_aggreateSide.get(order.price) === undefined) {
                    _aggreateSide.set(order.price, order.size);
                } else {
                    _aggreateSide.set(order.price, _aggreateSide.get(order.price) + order.size);
                }
            });
            // Construct array for our orderbook system
            let __side: any[][];
            if (_aggreateSide) {
                __side = Array.from(_aggreateSide.entries()).map((_side_) => [
                    (_side_[0].toFixed(4)),
                    _side_[1],
                ]);
            } else {
                // Return default values of 0
                return [[0, 0]];
            }
            // Update our values for the orderbook and order list
            if (isPassMarket) {
                if (side === 'asks') {
                    setPassAsks(__side);
                } else {
                    setPassBids(__side);
                }
                setLastPassSlotUpdated(ctx.slot);
            } else {
                if (side === 'asks') {
                    setFailAsks(__side);
                } else {
                    setFailBids(__side);
                }
                setLastFailSlotUpdated(ctx.slot);
            }

            //update our order table
            // const addOrders = _side.map<OrderBookOrder>(sideOrder => {
            //     return {
            //         account: {
            //             accountNum: sideOrder.ownerSlot,
            // market: sideOrder.market,
            //             owner: sideOrder.owner,
            //             name: [3],
            //             openOrders: [],
            //             bump: 0,
            //             delegate: [],
            //             padding: [],
            //             position: [],
            //         },
            //         publicKey: leafNodes.owner
            //     };
            // });
            // const newOrders = [...orders, ...addOrders];
            // setOrders(newOrders);

            // Check that we have books

            let tobAsk: number;
            let tobBid: number;

            // Get top of books
            if (side === 'asks') {
                tobAsk = Number(__side[0][0]);
                // @ts-ignore
                tobBid = Number(bids[0][0]);
            } else {
                // @ts-ignore
                tobAsk = Number(asks[0][0]);
                tobBid = Number(__side[0][0]);
            }
            // Calculate spread
            const spread: number = tobAsk - tobBid;
            // Calculate spread percent
            const spreadPercent: string = ((spread / tobBid) * 100).toFixed(2);
            let _spreadString: string;
            // Create our string for output into the orderbook object
            if (spread === tobAsk) {
                _spreadString = '∞';
            } else {
                _spreadString = `${spread.toFixed(2).toString()} (${spreadPercent}%)`;
            }
            if (isPassMarket) {
                setPassSpreadString(
                    (curSpreadString) => curSpreadString === _spreadString ? curSpreadString : _spreadString
                );
            } else {
                setFailSpreadString(
                    (curSpreadString) => curSpreadString === _spreadString ? curSpreadString : _spreadString
                );
            }

            setWsConnected((curConnected) => curConnected === false);
        } catch (err) {
            // console.error(err);
            // TODO: Add in call to analytics / reporting
        }
    };

    useEffect(() => {
        console.log("order book orders");
        console.log(orderBookObject?.orders);
        if (passBids.length === 0 && !!orderBookObject?.passBidsArray) {
            setPassBids(orderBookObject.passBidsArray);
        }
        if (failBids.length === 0 && !!orderBookObject?.failBidsArray?.length) {
            setFailBids(orderBookObject.failBidsArray);
        }
        if (passAsks.length === 0 && !!orderBookObject?.passAsksArray?.length) {
            setPassAsks(orderBookObject.passAsksArray);
        }
        if (failAsks.length === 0 && !!orderBookObject?.failAsksArray?.length) {
            setFailAsks(orderBookObject.failAsksArray);
        }

        if (!passSpreadString && !!orderBookObject?.passSpreadString) {
            setPassSpreadString(orderBookObject.passSpreadString);
        }
        if (!failSpreadString && !!orderBookObject?.failSpreadString) {
            setFailSpreadString(orderBookObject.failSpreadString);
        }
        if (orders.length === 0 && !!orderBookObject?.orders) {
            setOrders(orderBookObject?.orders);
        }
    }, [orderBookObject]);

    const listenOrderBooks = async () => {
        if (!proposal) return;

        let markets = [proposal?.account.openbookFailMarket, proposal?.account.openbookPassMarket];

        // Setup for pass and fail markets
        // bubble down what the market is you are getting the update for
        markets.forEach(async (market: PublicKey) => {
            if (!wsConnected) {
                // Fetch via RPC for the openbook market
                const _market = await openBookProgram.account.market.fetch(
                    market
                );
                const sides = [
                    {
                        pubKey: _market.asks,
                        side: 'asks',
                    },
                    {
                        pubKey: _market.bids,
                        side: 'bids',
                    },
                ];
                // Setup Websocket subscription for the two sides
                try {
                    const subscriptionId = sides.map((side) => provider.connection.onAccountChange(
                        side.pubKey,
                        (updatedAccountInfo, ctx) => {
                            consumeOrderBookSide(side.side, updatedAccountInfo, market, ctx);
                        },
                        'processed'
                    )
                    );
                    return subscriptionId;
                } catch (err) {
                    setWsConnected(false);
                }
            }
            // For map handling
            return null;
        });
    };

    useEffect(() => {
        if (!wsConnected && proposal) {
            // connect for both pass and fail market order books
            listenOrderBooks();
        }
    }, [wsConnected, !!proposal]);
    useEffect(() => {
        fetchMarketsInfo();
    }, [proposal]);

    const memoValue = useMemo(() => {
        return {
            markets,
            orders,
            orderBookObject,
            loading,
            passAsks,
            passBids,
            failAsks,
            failBids,
            lastPassSlotUpdated,
            lastFailSlotUpdated,
            passSpreadString,
            failSpreadString,
            fetchOpenOrders,
            fetchMarketsInfo,
            placeOrderTransactions,
            placeOrder,
        };
    }, [orders.length, loading, passAsks.length, passBids.length, failAsks.length, failBids.length, passSpreadString, failSpreadString]);

    return (
        <OrdersContext.Provider
            value={memoValue}
        >
            {children}
        </OrdersContext.Provider>
    );
}
