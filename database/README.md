# E-Commerce Database Schema

This directory contains the SQL migrations for the e-commerce database structure.

## Schema Overview

The database is designed to support a large e-commerce platform with Ukrainian as the primary language, while being prepared for multi-language support and 1C integration.

## Tables Structure

### Core Entities
1. **categories** - Product categories with nested structure
2. **products** - Main product information with SKU, pricing, inventory
3. **product_images** - Product image gallery
4. **product_variants** - Product variants (colors, sizes, etc.)
5. **attributes** - Product attributes (color, size, material)
6. **attribute_values** - Values for attributes
7. **product_attribute_values** - Junction table linking products to attribute values
8. **brands** - Brand information

### Customer & Order Management
9. **customers** - Customer data
10. **orders** - Order tracking with status and payment info
11. **order_items** - Individual items within orders
12. **product_stock_history** - Track inventory changes

### Multi-language Support
13. **categories_translations**
14. **products_translations**
15. **brands_translations**
16. **attributes_translations**
17. **attribute_values_translations**

## Key Features

- **UUID Primary Keys**: All tables use UUIDs for consistent cross-system references
- **Foreign Key Constraints**: Proper relationships with appropriate ON DELETE actions
- **Row Level Security (RLS)**: Public users can only read active entities, others cannot modify data
- **Performance Indexes**: Optimized indexes on commonly queried columns
- **Data Validation**: Comprehensive CHECK constraints to maintain data integrity
- **Multi-language Support**: Ready for Ukrainian, Polish, and English translations
- **1C Integration Ready**: Schema designed to support synchronization with 1C 7.7

## Database Design Principles

- **No Negative Inventory**: Check constraints prevent negative stock quantities
- **Currency Handling**: Prices stored as NUMERIC(12,2) for precise financial calculations
- **Time Stamps**: Using TIMESTAMPTZ for timezone-aware timestamps
- **Immutable Data**: Translation data is separate from core entities
- **Extensible Structure**: Easy to add new attributes and translations without restructuring

## RLS Policy Details

- Public users can only read:
  - Active categories (is_active = TRUE)
  - Active products (is_active = TRUE)
  - Product images
  - Active product variants
  - Attributes and attribute values
  - Active brands
- All other operations require authentication or admin access

## Usage

To apply these migrations to your Supabase database:

1. Ensure you have a Supabase project set up with PostgreSQL
2. Run the migration files in order:
   - First run `001_initial_schema.sql`
   - Then run `002_constraints_and_indexes.sql`

## Future Considerations

- The schema is designed to integrate smoothly with 1C 7.7 through product_stock_history table
- Translation system allows for easy addition of new languages without restructuring existing data
- All core functionality supports large-scale operations and high volume transactions