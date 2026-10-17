// The read-back's MYOB client (plan M10 review, R2): GET only. The read-back
// never holds a create or put function, so no setting of the master switch or
// the update control can turn a read-back into a write; a static test keeps the
// read-back files and refreshMyobRecord free of the write client.

import { getPurchase, MyobPurchaseError } from "../myob-purchase-order";

export { MyobPurchaseError };

export interface MyobReader {
  readonly get: typeof getPurchase;
}

export const LIVE_READER: MyobReader = Object.freeze({ get: getPurchase });
