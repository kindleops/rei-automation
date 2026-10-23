-- DISPOSABLE-TEST EMULATION of the PostGIS 3.3.7 management functions (see postgis.control). Signatures are the
-- real ones (postgis/postgis.sql.in + postgis/long_xact.sql.in at tag 3.3.7). The 13 overloads whose real bodies
-- run dynamic SQL (plpgsql EXECUTE over quote_ident-built identifiers) do the same here, against nothing that
-- matters; the other 13 are thin wrappers, as in PostGIS. All are SECURITY INVOKER, as in PostGIS.
\echo Use "CREATE EXTENSION postgis" to load this file. \quit

create table spatial_ref_sys (srid integer primary key, auth_name varchar(256), srtext varchar(2048));
grant select on spatial_ref_sys to public;

-- ------------------------------------------------------------- the 13 dynamic-SQL overloads ----
create function addgeometrycolumn(catalog_name varchar, schema_name varchar, table_name varchar, column_name varchar, new_srid_in integer, new_type varchar, new_dim integer, use_typmod boolean default true)
returns text language plpgsql strict as $$
begin
  execute 'ALTER TABLE ' || quote_ident(schema_name) || '.' || quote_ident(table_name) || ' ADD COLUMN ' || quote_ident(column_name) || ' text';
  return schema_name || '.' || table_name || '.' || column_name;
end $$;
create function dropgeometrycolumn(catalog_name varchar, schema_name varchar, table_name varchar, column_name varchar)
returns text language plpgsql strict as $$
begin
  execute 'ALTER TABLE ' || quote_ident(schema_name) || '.' || quote_ident(table_name) || ' DROP COLUMN ' || quote_ident(column_name);
  return schema_name || '.' || table_name || '.' || column_name || ' effectively removed.';
end $$;
create function dropgeometrytable(catalog_name varchar, schema_name varchar, table_name varchar)
returns text language plpgsql strict as $$
begin
  execute 'DROP TABLE IF EXISTS ' || quote_ident(schema_name) || '.' || quote_ident(table_name) || ' RESTRICT';
  return schema_name || '.' || table_name || ' dropped.';
end $$;
create function updategeometrysrid(catalogn_name varchar, schema_name varchar, table_name varchar, column_name varchar, new_srid_in integer)
returns text language plpgsql strict as $$
begin
  execute 'SELECT count(*) FROM ' || quote_ident(schema_name) || '.' || quote_ident(table_name);
  return schema_name || '.' || table_name || '.' || column_name || ' SRID changed to ' || new_srid_in;
end $$;
create function populate_geometry_columns(tbl_oid oid, use_typmod boolean default true)
returns integer language plpgsql as $$
declare n integer;
begin
  execute 'SELECT count(*) FROM ' || tbl_oid::regclass::text into n;
  return 0;
end $$;
create function st_findextent(text, text, text) returns text language plpgsql stable strict as $$
declare r text;
begin
  execute 'SELECT NULL::text FROM ' || quote_ident($1) || '.' || quote_ident($2) || ' LIMIT 0' into r;
  return r;
end $$;
create function st_findextent(text, text) returns text language plpgsql stable strict as $$
declare r text;
begin
  execute 'SELECT NULL::text FROM ' || quote_ident($1) || ' LIMIT 0' into r;
  return r;
end $$;
create function postgis_extensions_upgrade() returns text language plpgsql as $$
begin
  execute 'SELECT 1';
  return 'Upgrade completed';
end $$;
create function unlockrows(text) returns integer language plpgsql strict as $$
begin
  execute 'SELECT 0';
  return 0;
end $$;
create function lockrow(text, text, text, text, timestamp) returns integer language plpgsql strict as $$
begin
  execute 'SELECT 1 FROM ' || quote_ident($1) || '.' || quote_ident($2) || ' LIMIT 0';
  return 1;
end $$;
create function checkauth(text, text, text) returns integer language plpgsql as $$
begin
  execute 'SELECT 1 FROM ' || quote_ident($1) || '.' || quote_ident($2) || ' LIMIT 0';
  return 0;
end $$;
create function enablelongtransactions() returns text language plpgsql as $$
begin
  execute 'SELECT 1';
  return 'Long transactions support enabled';
end $$;
create function disablelongtransactions() returns text language plpgsql as $$
begin
  execute 'SELECT 1';
  return 'Long transactions support disabled';
end $$;

-- ----------------------------------------------------------------------- the 13 thin wrappers ----
create function addgeometrycolumn(schema_name varchar, table_name varchar, column_name varchar, new_srid integer, new_type varchar, new_dim integer, use_typmod boolean default true)
returns text language plpgsql stable strict as $$ declare ret text; begin select @extschema@.addgeometrycolumn('', $1, $2, $3, $4, $5, $6, $7) into ret; return ret; end $$;
create function addgeometrycolumn(table_name varchar, column_name varchar, new_srid integer, new_type varchar, new_dim integer, use_typmod boolean default true)
returns text language plpgsql strict as $$ declare ret text; begin select @extschema@.addgeometrycolumn('', '', $1, $2, $3, $4, $5, $6) into ret; return ret; end $$;
create function dropgeometrycolumn(schema_name varchar, table_name varchar, column_name varchar)
returns text language plpgsql strict as $$ declare ret text; begin select @extschema@.dropgeometrycolumn('', $1, $2, $3) into ret; return ret; end $$;
create function dropgeometrycolumn(table_name varchar, column_name varchar)
returns text language plpgsql strict as $$ declare ret text; begin select @extschema@.dropgeometrycolumn('', '', $1, $2) into ret; return ret; end $$;
create function dropgeometrytable(schema_name varchar, table_name varchar) returns text language sql strict as $$ select @extschema@.dropgeometrytable('', $1, $2) $$;
create function dropgeometrytable(table_name varchar) returns text language sql strict as $$ select @extschema@.dropgeometrytable('', '', $1) $$;
create function updategeometrysrid(varchar, varchar, varchar, integer)
returns text language plpgsql strict as $$ declare ret text; begin select @extschema@.updategeometrysrid('', $1, $2, $3, $4) into ret; return ret; end $$;
create function updategeometrysrid(varchar, varchar, integer)
returns text language plpgsql strict as $$ declare ret text; begin select @extschema@.updategeometrysrid('', '', $1, $2, $3) into ret; return ret; end $$;
create function populate_geometry_columns(use_typmod boolean default true) returns text language plpgsql as $$ begin return 'probed:0 inserted:0'; end $$;
create function lockrow(text, text, text, text) returns integer language sql strict as $$ select @extschema@.lockrow($1, $2, $3, $4, now()::timestamp + '1:00') $$;
create function lockrow(text, text, text) returns integer language sql strict as $$ select @extschema@.lockrow(current_schema(), $1, $2, $3, now()::timestamp + '1:00') $$;
create function lockrow(text, text, text, timestamp) returns integer language sql strict as $$ select @extschema@.lockrow(current_schema(), $1, $2, $3, $4) $$;
create function checkauth(text, text) returns integer language sql as $$ select @extschema@.checkauth('', $1, $2) $$;
