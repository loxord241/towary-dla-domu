-- Migration: Fix RLS policies for e-commerce schema
-- This migration corrects problematic RLS policies and ensures proper access control

-- Remove duplicate attribute_values policies (there were two identical policies)
-- Note: We'll first drop the existing policies before creating corrected ones

-- Drop duplicate policy for attribute values
DROP POLICY IF EXISTS "Enable read access to active attribute values" ON attribute_values;

-- Drop existing policy for product images with too broad USING clause
-- (We need to be more specific about active products)
DROP POLICY IF EXISTS "Enable read access to product images" ON product_images;

-- Drop policies for translation tables
DROP POLICY IF EXISTS "Enable read access to product translations" ON products_translations;
DROP POLICY IF EXISTS "Enable read access to category translations" ON categories_translations;
DROP POLICY IF EXISTS "Enable read access to brand translations" ON brands_translations;
DROP POLICY IF EXISTS "Enable read access to attribute translations" ON attributes_translations;
DROP POLICY IF EXISTS "Enable read access to attribute value translations" ON attribute_values_translations;

-- Create corrected policies for product images
CREATE POLICY "Enable read access to product images" ON product_images
    FOR SELECT USING (product_id IN (SELECT id FROM products WHERE is_active = TRUE));

-- Create corrected policies for attribute values
CREATE POLICY "Enable read access to active attribute values" ON attribute_values
    FOR SELECT USING (attribute_id IN (SELECT id FROM attributes));

-- Create corrected policies for translation tables - only allow translations of active entities
CREATE POLICY "Enable read access to product translations" ON products_translations
    FOR SELECT USING (product_id IN (SELECT id FROM products WHERE is_active = TRUE));

CREATE POLICY "Enable read access to category translations" ON categories_translations
    FOR SELECT USING (category_id IN (SELECT id FROM categories WHERE is_active = TRUE));

CREATE POLICY "Enable read access to brand translations" ON brands_translations
    FOR SELECT USING (brand_id IN (SELECT id FROM brands WHERE is_active = TRUE));

CREATE POLICY "Enable read access to attribute translations" ON attributes_translations
    FOR SELECT USING (attribute_id IN (SELECT id FROM attributes));

CREATE POLICY "Enable read access to attribute value translations" ON attribute_values_translations
    FOR SELECT USING (attribute_value_id IN (SELECT id FROM attribute_values WHERE attribute_id IN (SELECT id FROM attributes)));

-- Ensure public user cannot INSERT, UPDATE or DELETE on catalog data
-- Note: No need for explicit FOR ALL USING (FALSE) policies as RLS prevents all operations by default 
-- when no matching policies exist for those operations. All entities are properly filtered to only allow 
-- SELECT access to active records.