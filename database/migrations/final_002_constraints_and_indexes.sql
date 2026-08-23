-- Migration: Additional constraints and indexes for e-commerce schema
-- This migration adds more precise constraints, indexes, and data validation

-- Update product_images table with additional constraint on image_url
ALTER TABLE product_images ADD CONSTRAINT chk_image_url_not_empty CHECK (image_url IS NOT NULL AND image_url != '');

-- Add unique constraint to ensure one main image per product
CREATE UNIQUE INDEX idx_product_images_main_per_product ON product_images(product_id) WHERE is_main = TRUE;

-- Add brand foreign key to products
ALTER TABLE products ADD COLUMN brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

-- Create function to validate brand is active when assigned to product
CREATE OR REPLACE FUNCTION validate_product_brand()
RETURNS TRIGGER AS $$
BEGIN
    -- If brand_id is null, allow (product can be unbranded)
    IF NEW.brand_id IS NULL THEN 
        RETURN NEW;
    END IF;
    
    -- Check that brand exists and is active
    IF NOT EXISTS (
        SELECT 1 FROM brands 
        WHERE id = NEW.brand_id AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Brand must exist and be active';
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to validate brand on product insert/update
CREATE TRIGGER trigger_validate_product_brand
    BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION validate_product_brand();

-- Create function to handle brand deactivation
CREATE OR REPLACE FUNCTION handle_brand_deactivation()
RETURNS TRIGGER AS $$
BEGIN
    -- If a brand is being deactivated, check that no active products reference it
    IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
        IF EXISTS (
            SELECT 1 FROM products 
            WHERE brand_id = NEW.id AND is_active = TRUE
        ) THEN
            RAISE EXCEPTION 'Cannot deactivate brand while active products reference it';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to validate brand deactivation
CREATE TRIGGER trigger_handle_brand_deactivation
    BEFORE UPDATE ON brands
    FOR EACH ROW EXECUTE FUNCTION handle_brand_deactivation();

-- Add indexes for brand relationships
CREATE INDEX idx_products_brand_id ON products(brand_id);
CREATE INDEX idx_brands_is_active ON brands(is_active);

-- Add customer constraints
ALTER TABLE customers ADD CONSTRAINT chk_customer_email_not_empty CHECK (email IS NOT NULL AND email != '');
CREATE INDEX idx_customers_email ON customers(email);

-- Add order status constraints
ALTER TABLE orders ADD CONSTRAINT chk_orders_status_valid CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'));

-- NOTE: the following FK constraints are intentionally NOT re-created here.
-- An earlier revision of this migration added chk_*_translations_*_id
-- FOREIGN KEY constraints duplicating the REFERENCES clauses that
-- final_001 already created on those columns. Duplicate FKs make PostgREST
-- relationship embedding ambiguous ("more than one relationship was found")
-- and serve no purpose, so they were dropped from this migration.

-- Add attribute translations foreign key constraint
ALTER TABLE attributes_translations ADD CONSTRAINT chk_attributes_translations_attribute_id FOREIGN KEY (attribute_id) REFERENCES attributes(id) ON DELETE CASCADE;

-- Add attribute value translations foreign key constraint
ALTER TABLE attribute_values_translations ADD CONSTRAINT chk_attribute_values_translations_attribute_value_id FOREIGN KEY (attribute_value_id) REFERENCES attribute_values(id) ON DELETE CASCADE;

-- Create partial indexes for better query performance
CREATE INDEX idx_products_active_featured ON products(is_active, is_featured) WHERE is_active = TRUE;
CREATE INDEX idx_products_category_active ON products(category_id, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_products_price ON products(price);
CREATE INDEX idx_product_variants_product_active ON product_variants(product_id, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_attributes_type ON attributes(type);

-- Add more constraints for data integrity
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_product_or_variant CHECK (
    (product_id IS NOT NULL AND variant_id IS NULL) OR 
    (product_id IS NULL AND variant_id IS NOT NULL)
);

-- Ensure that product variants have unique combinations of product and name
CREATE UNIQUE INDEX idx_product_variants_unique_name_per_product ON product_variants(product_id, name) WHERE is_active = TRUE;

-- Create function to check if stock quantity can be updated safely (prevent negative values)
CREATE OR REPLACE FUNCTION check_stock_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stock_quantity < 0 THEN
        RAISE EXCEPTION 'Stock quantity cannot be negative';
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for stock validation
CREATE TRIGGER validate_product_stock BEFORE UPDATE OR INSERT ON products FOR EACH ROW EXECUTE FUNCTION check_stock_update();
CREATE TRIGGER validate_variant_stock BEFORE UPDATE OR INSERT ON product_variants FOR EACH ROW EXECUTE FUNCTION check_stock_update();

-- Add more RLS policies for better security
CREATE POLICY "Enable read access to active attribute values" ON attribute_values
    FOR SELECT USING (attribute_id IN (SELECT id FROM attributes WHERE is_active = TRUE));

CREATE POLICY "Enable read access to attribute value translations" ON attribute_values_translations
    FOR SELECT USING (attribute_value_id IN (SELECT id FROM attribute_values WHERE attribute_id IN (SELECT id FROM attributes WHERE is_active = TRUE)));

-- Add translation policies for other entities
CREATE POLICY "Enable read access to product translations" ON products_translations
    FOR SELECT USING (product_id IN (SELECT id FROM products WHERE is_active = TRUE));

CREATE POLICY "Enable read access to category translations" ON categories_translations
    FOR SELECT USING (category_id IN (SELECT id FROM categories WHERE is_active = TRUE));

CREATE POLICY "Enable read access to brand translations" ON brands_translations
    FOR SELECT USING (brand_id IN (SELECT id FROM brands WHERE is_active = TRUE));

CREATE POLICY "Enable read access to attribute translations" ON attributes_translations
    FOR SELECT USING (attribute_id IN (SELECT id FROM attributes WHERE is_active = TRUE));