-- Correr en el SQL Editor de Supabase

alter table pedidos add column if not exists metodo_pago text;
alter table pedidos add column if not exists rubro text;
alter table pedidos add column if not exists deducible boolean;
alter table pedidos add column if not exists producto_generico text;
alter table pedidos add column if not exists comentarios text;
alter table pedidos add column if not exists cargado_en_cotizador boolean default false;
alter table pedidos add column if not exists moneda_original text;
alter table pedidos add column if not exists tipo_cambio numeric;
alter table pedidos add column if not exists iva_monto numeric;

-- Tabla de configuración general de la app (umbral de alertas, etc.)
create table if not exists config (
  id int primary key default 1,
  dias_alerta_factura int default 7,
  monto_alerta numeric default 100000,
  updated_at timestamptz default now(),
  constraint solo_una_fila check (id = 1)
);
insert into config (id) values (1) on conflict (id) do nothing;

alter table config enable row level security;
create policy "Lectura pública de config" on config for select using (true);
create policy "Actualización pública de config" on config for update using (true);
