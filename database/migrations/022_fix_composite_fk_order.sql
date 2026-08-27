-- Migration 022: composite FK column-order fix (stage 2D, live verification finding)
--
-- BUG (from migration 020, discovered live during stage 2D verification):
-- FK column lists match BY POSITION. Migration 020 declared
--
--     foreign key (shipment_id, order_id)
--     references order_shipments(order_id, id)
--     foreign key (order_item_id, order_id)
--     references order_items(order_id, id)
--
-- which enforces (verified live in a sandbox AND with the real tables):
--     order_shipments.order_id = order_shipment_items.shipment_id
--     AND order_shipments.id   = order_shipment_items.order_id
-- — the WRONG pairing. A correct shipment-item row (shipment_id = shipment
-- id, order_id = order id) is REJECTED; the swapped pair is accepted.
-- Effect: order_shipment_items is unwritable in production. The tables are
-- empty (verified before 020 was applied), so nothing was corrupted and
-- nobody could notice until the first writer (stage 2D RPC) ran.
--
-- FIX: drop both FKs and re-add them with the referenced list (id, order_id):
--     shipment_id ↔ order_shipments.id
--     order_id    ↔ order_shipments.order_id
-- The unique indexes uq_order_shipments_order_id_id (order_id, id) and
-- uq_order_items_order_id_id (order_id, id) from 020 serve as FK targets —
-- Postgres matches the referenced column SET regardless of index order
-- (verified live: correct pair accepted, swapped pair rejected).
-- Cross-order integrity intent of 020 is preserved exactly: a link row can
-- only exist when both parents belong to the same order.
--
-- Safety: production tables order_shipment_items / order_shipment_parcels /
-- order_shipments are EMPTY (verified live before applying). The ALTERs are
-- metadata-only (validated on empty tables).
--
-- Scope guard (stage 2D, explicit GO 2026-08-27): no checkout/payment/
-- LiqPay changes, no Nova Post client changes, no RLS changes.
--
-- Idempotency: guarded DROP IF EXISTS + ADD. Rerunnable.

begin;

-- ==================== SHIPMENT → ORDER SHIPMENTS ====================

alter table order_shipment_items
    drop constraint if exists fk_order_shipment_items_shipment_order;
alter table order_shipment_items
    add constraint fk_order_shipment_items_shipment_order
    foreign key (shipment_id, order_id) references order_shipments (id, order_id)
    on delete cascade;

-- ==================== ITEM → ORDER ITEMS ====================

alter table order_shipment_items
    drop constraint if exists fk_order_shipment_items_item_order;
alter table order_shipment_items
    add constraint fk_order_shipment_items_item_order
    foreign key (order_item_id, order_id) references order_items (id, order_id)
    on delete cascade;

commit;
