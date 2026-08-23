-- Migration: Supabase Storage setup for product images
-- This migration prepares the database structure to work with Supabase Storage

-- Note: The actual bucket creation is done through Supabase UI or API
-- This file contains only RLS policies for the existing product_images table

-- Enable RLS on existing product_images table (if not already enabled)
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;

-- Policy for existing product_images table
-- Public users can read product images for active products only
CREATE POLICY "Enable read access to product images for active products" ON product_images
    FOR SELECT USING (
        product_id IN (SELECT id FROM products WHERE is_active = TRUE)
    );

-- Prevent modification of product_images by public users
-- This policy will be enforced by Supabase Storage policies, not SQL
CREATE POLICY "Disable all non-read access to product images" ON product_images
    FOR ALL USING (FALSE);

-- Notes for Supabase Storage configuration:
-- 
-- 1. Bucket creation (via Supabase UI):
--    - Go to Storage → Buckets
--    - Create new bucket named "product_images"
--    - Set bucket to "Public" access level
--    - This allows anonymous users to download files from the bucket
--
-- 2. Storage policies (via Supabase UI):
--    - Go to Storage → Bucket → Policies
--    - For the "product_images" bucket:
--      - Policy 1: Allow read for all users (for paths under "products/*")  
--        - This enables public access to product images
--      - Policy 2: Allow upload, update, delete only for authenticated users with admin privileges
--        - Only authenticated users can modify files
--        - These should be restricted based on user roles in future implementation
--
-- 3. Path structure (handled by application code):
--    - products/{product_id}/main/{filename}
--    - products/{product_id}/gallery/{filename}
--    - categories/{category_id}/{filename}
--
-- 4. Security model:
--    - Product images are linked to products with RLS protection in the database
--    - Files are publicly readable through Storage bucket, but API access is protected by RLS
--    - This design follows the principle of "storage is public, database access is controlled"