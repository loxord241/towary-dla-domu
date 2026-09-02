-- Migration: Initial e-commerce schema for Ukrainian store
-- This migration creates all required tables, relationships, indexes, constraints and RLS policies

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Categories table with nested structure
CREATE TABLE categories (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    parent_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    image TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products table
CREATE TABLE products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    short_description TEXT,
    description TEXT,
    price NUMERIC(12, 2) NOT NULL,
    old_price NUMERIC(12, 2),
    currency TEXT DEFAULT 'UAH',
    stock_quantity INTEGER DEFAULT 0,
    availability_status TEXT DEFAULT 'in_stock', -- in_stock, out_of_stock, limited_availability
    is_active BOOLEAN DEFAULT TRUE,
    is_featured BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Product images table
CREATE TABLE product_images (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    alt TEXT,
    sort_order INTEGER DEFAULT 0,
    is_main BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Product variants table
CREATE TABLE product_variants (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT UNIQUE,
    price NUMERIC(12, 2) NOT NULL,
    old_price NUMERIC(12, 2),
    stock_quantity INTEGER DEFAULT 0,
    availability_status TEXT DEFAULT 'in_stock',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Attributes table
CREATE TABLE attributes (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL -- e.g., 'color', 'size', 'material'
);

-- Attribute values table
CREATE TABLE attribute_values (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    attribute_id UUID REFERENCES attributes(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    slug TEXT NOT NULL
);

-- Product attribute values junction table
CREATE TABLE product_attribute_values (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    attribute_value_id UUID REFERENCES attribute_values(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Brands table
CREATE TABLE brands (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    logo TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers table
CREATE TABLE customers (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders table
CREATE TABLE orders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'pending', -- pending, confirmed, shipped, delivered, cancelled, returned
    total_amount NUMERIC(12, 2) NOT NULL,
    currency TEXT DEFAULT 'UAH',
    customer_info JSONB, -- snapshot of customer info for order history
    shipping_info JSONB, -- shipping address and details
    payment_info JSONB, -- payment info snapshot
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order items table
CREATE TABLE order_items (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    total NUMERIC(12, 2) NOT NULL
);

-- Product stock history table
CREATE TABLE product_stock_history (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    old_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    reason TEXT NOT NULL, -- manual, 1c, order, return, correction
    source TEXT NOT NULL, -- manual, 1c, order, return, correction
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Translation tables for multi-language support (uk, pl, en)

-- Categories translations
CREATE TABLE categories_translations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    UNIQUE(category_id, language_code)
);

-- Products translations
CREATE TABLE products_translations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    name TEXT NOT NULL,
    short_description TEXT,
    description TEXT,
    UNIQUE(product_id, language_code)
);

-- Brands translations
CREATE TABLE brands_translations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    UNIQUE(brand_id, language_code)
);

-- Attributes translations
CREATE TABLE attributes_translations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    attribute_id UUID REFERENCES attributes(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(attribute_id, language_code)
);

-- Attribute values translations
CREATE TABLE attribute_values_translations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    attribute_value_id UUID REFERENCES attribute_values(id) ON DELETE CASCADE,
    language_code TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(attribute_value_id, language_code)
);

-- Add indexes for better performance
CREATE INDEX idx_categories_parent_id ON categories(parent_id);
CREATE INDEX idx_categories_is_active ON categories(is_active);
CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_is_active ON products(is_active);
CREATE INDEX idx_products_is_featured ON products(is_featured);
CREATE INDEX idx_products_availability_status ON products(availability_status);
CREATE INDEX idx_product_images_product_id ON product_images(product_id);
CREATE INDEX idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX idx_attribute_values_attribute_id ON attribute_values(attribute_id);
CREATE INDEX idx_product_attribute_values_product_id ON product_attribute_values(product_id);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
CREATE INDEX idx_product_stock_history_product_id ON product_stock_history(product_id);
CREATE INDEX idx_product_stock_history_variant_id ON product_stock_history(variant_id);

-- Create triggers for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_variants_updated_at BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_brands_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create RLS policies
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_stock_history ENABLE ROW LEVEL SECURITY;

-- Enable RLS for translation tables
ALTER TABLE categories_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE products_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attributes_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_values_translations ENABLE ROW LEVEL SECURITY;

-- RLS policies for public access (read-only)
CREATE POLICY "Enable read access to active categories" ON categories
    FOR SELECT USING (is_active = TRUE);

CREATE POLICY "Enable read access to active products" ON products
    FOR SELECT USING (is_active = TRUE);

CREATE POLICY "Enable read access to product images" ON product_images
    FOR SELECT USING (product_id IN (SELECT id FROM products WHERE is_active = TRUE));

CREATE POLICY "Enable read access to product variants" ON product_variants
    FOR SELECT USING (is_active = TRUE AND product_id IN (SELECT id FROM products WHERE is_active = TRUE));

-- NOTE: the attributes table has no is_active column in this schema, so the
-- policy grants plain read access. (An earlier revision referenced
-- attributes.is_active here and would fail on a fresh deployment.)
CREATE POLICY "Enable read access to active attributes" ON attributes
    FOR SELECT USING (TRUE);

-- NOTE: attributes has no is_active column in this schema — the policy
-- grants plain read access filtered by attribute_id only (an earlier
-- revision referenced attributes.is_active here and failed on a fresh
-- deployment).
CREATE POLICY "Enable read access to attribute values" ON attribute_values
    FOR SELECT USING (attribute_id IN (SELECT id FROM attributes));

CREATE POLICY "Enable read access to active brands" ON brands
    FOR SELECT USING (is_active = TRUE);

-- Additional validation constraints
ALTER TABLE products ADD CONSTRAINT chk_products_price_non_negative CHECK (price >= 0);
ALTER TABLE products ADD CONSTRAINT chk_products_old_price_non_negative CHECK (old_price IS NULL OR old_price >= 0);
ALTER TABLE product_variants ADD CONSTRAINT chk_variants_price_non_negative CHECK (price >= 0);
ALTER TABLE product_variants ADD CONSTRAINT chk_variants_old_price_non_negative CHECK (old_price IS NULL OR old_price >= 0);
ALTER TABLE products ADD CONSTRAINT chk_products_stock_quantity_non_negative CHECK (stock_quantity >= 0);
ALTER TABLE product_variants ADD CONSTRAINT chk_variants_stock_quantity_non_negative CHECK (stock_quantity >= 0);

-- Additional constraints
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0);
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_price_positive CHECK (price >= 0);
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_total_positive CHECK (total >= 0);

-- Tables are NOT world-readable by default: a GRANT SELECT TO public here
-- made every new table readable by anon until RLS was enabled in the same
-- migration (this is how admin_users leaked). Privileges are granted
-- explicitly per-table where anonymous SELECT is actually intended.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE SELECT ON TABLES FROM public;