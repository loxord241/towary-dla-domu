-- Migration: Create minimal admin role system for catalog management
-- This migration creates all required tables and functions for secure admin access

-- Enable UUID extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table to store administrator users 
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create a trigger to update the updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_admin_users_updated_at 
    BEFORE UPDATE ON admin_users 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add the public user (for testing) to the admin system
-- This should be done manually after deployment in production
-- INSERT INTO admin_users (email) VALUES ('admin@example.com');

-- Create a function to check if current user is an admin
-- This function will be used by server-side code to validate admin access
CREATE OR REPLACE FUNCTION is_current_user_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM admin_users 
        WHERE email = (SELECT email FROM auth.identities WHERE id = current_setting('request.jwt.claims', true)::json->>'sub')
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Ensure that only admin users can access the admin system
-- RLS policies are handled at a higher level by the application code

COMMIT;