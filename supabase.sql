-- Tabla de pedidos de Tamales Doña Juana.
-- Pégalo en Supabase → SQL Editor → New query → Run.
create table if not exists pedidos_tamales (
  id             bigint generated always as identity primary key,
  codigo         text unique not null,          -- DJ-XXXXXX, va como referencia en Mercado Pago
  creado         timestamptz not null default now(),
  estado_pago    text not null default 'pendiente',   -- pendiente | pagado
  mp_payment_id  text,
  pagado_en      timestamptz,
  nombre         text not null,
  telefono       text not null,
  correo         text,
  tipo_entrega   text not null,                 -- domicilio | recoger
  cp             text,
  colonia        text,
  direccion      text,
  fecha_entrega  date not null,
  horario        text not null,
  notas          text,
  piezas         int not null,
  sabores        jsonb not null,                -- piezas por sabor: {"Puerco en adobo": 12, ...}
  paquetes       jsonb not null,                -- lo que armó el cliente, tal cual
  subtotal       numeric not null,
  envio          numeric not null default 0,
  total          numeric not null
);
create index if not exists pedidos_tamales_fecha on pedidos_tamales (fecha_entrega, horario);
-- Nadie entra desde el navegador; solo el puente con la llave de servicio.
alter table pedidos_tamales enable row level security;

-- Vista para cocina: cuántas piezas de cada sabor hay que hacer por día (solo pedidos pagados).
create or replace view produccion_por_dia as
select fecha_entrega, s.key as sabor, sum((s.value)::int) as piezas
from pedidos_tamales, jsonb_each_text(sabores) s
where estado_pago = 'pagado'
group by fecha_entrega, s.key
order by fecha_entrega, s.key;
