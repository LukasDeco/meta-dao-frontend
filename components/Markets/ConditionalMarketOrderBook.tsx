import { useMemo } from 'react';
import { OrderBook } from '@lab49/react-order-book';
import { LeafNode } from '@/lib/types';

export function ConditionalMarketOrderBook({ bids, asks }: { bids: LeafNode[]; asks: LeafNode[] }) {
  const orderbook = useMemo(() => {
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
        return [[Number.MAX_SAFE_INTEGER, 0]];
    };
    const _bids = orderBookSide(bids, true);
    const _asks = orderBookSide(asks);

    const tobAsk: number = Number(_asks[0][0]);
    const tobBid: number = Number(_bids[0][0]);
    const spread: number = (tobAsk - tobBid);
    const spreadPercent: string = ((spread / tobAsk) * 100).toFixed(2);

    const spreadString = `${spread.toFixed(2).toString()} (${spreadPercent}%)`;

    return {
      bids: getSide(bids, true),
      asks: getSide(asks),
      spreadString,
    };
  }, [bids, asks]);

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .MakeItNice {
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 15px;
          font-variant-numeric: tabular-nums;
          display: inline-block;
        }

        .MakeItNice__list {
          list-style-type: none;
          padding: 0;
          margin: 0;
        }

        .MakeItNice__list-item {
          cursor: pointer;
          padding: 1px 20px 1px 20px;
          display: flex;
        }

        .MakeItNice__list-item:hover {
          background: rgb(240, 240, 240);
        }

        .MakeItNice__price {
          flex: 0 0 70px;
          color: var(--row-color);
          text-align: right;
          display: inline-block;
          margin-right: 15px;
        }

        .MakeItNice__size {
          flex: 0 0 70px;
        }

        .MakeItNice__spread {
          border-width: 1px 0;
          border-style: solid;
          border-color: rgba(150, 150, 150, 0.2);
          padding: 5px 20px;
          text-align: center;
          display: flex;
        }

        .MakeItNice__spread-header {
          margin: 0 15px 0 0;
          flex: 0 0 70px;
          text-align: right;
        }

        .MakeItNice__spread-value {
          width: 100%;
          text-align: left;
          overflow: hidden;
        }
      `,
        }}
      />
      <OrderBook
        book={{
          bids: orderbook?.bids
            ? Array.from(orderbook?.bids?.deduped.entries()).map((bid) => [
                (bid[0] / 10_000).toFixed(4),
                bid[1],
              ])
            : [[0, 0]],
          asks: orderbook?.asks
            ? Array.from(orderbook?.asks?.deduped.entries()).map((ask) => [
                (ask[0] / 10_000).toFixed(4),
                ask[1],
              ])
            : [[Number.MAX_SAFE_INTEGER, 0]],
        }}
        fullOpacity
        spread={orderbook.spreadString}
        interpolateColor={(color) => color}
        listLength={5}
        stylePrefix="MakeItNice"
      />
    </>
  );
}
