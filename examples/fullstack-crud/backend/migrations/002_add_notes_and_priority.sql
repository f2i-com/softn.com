ALTER TABLE items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE items ADD COLUMN notes TEXT;
UPDATE items SET priority = 'high', notes = 'Calibrated for production' WHERE sku = 'INV-1001';
