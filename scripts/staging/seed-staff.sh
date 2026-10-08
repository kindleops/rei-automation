#!/bin/sh
# Creates the two staging operators (Supabase Auth users on the STAGING branch
# only), allowlists them as operators, and grants scheduling.admin to one.
# Passwords are random, written only to the gitignored env file, never printed.
#   STAGING_LINK_DIR=… ENV_FILE=apps/api/.env.scheduling-staging.local scripts/staging/seed-staff.sh
set -eu
DIR="${STAGING_LINK_DIR:?}"; ENV_FILE="${ENV_FILE:?}"
[ "$(cat "$DIR/supabase/.temp/project-ref")" = "eiawfeddmmwwavzlfwia" ] || { echo "REFUSED: not staging" >&2; exit 2; }
q() { supabase db query --linked --workdir "$DIR" -o csv "$1" 2>&1 | grep -v "new version\|recommend\|Using workdir\|Initialising\|claude-code-hint\|^$" || true; }
[ "$(q "select project_ref||','||environment||','||production_fingerprint from public.staging_identity()" | tail -1 | tr -d '"')" = "eiawfeddmmwwavzlfwia,staging,false" ] || { echo "REFUSED: no staging identity" >&2; exit 2; }
git -C "$(dirname "$ENV_FILE")" check-ignore -q "$ENV_FILE" || { echo "REFUSED: $ENV_FILE is not gitignored" >&2; exit 2; }

for who in admin operator; do
  email="staging-$who@example.test"
  key="STAGING_$(echo "$who" | tr a-z A-Z)_PASSWORD"
  pw="$(grep "^$key=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [ -z "$pw" ]; then pw="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"; printf '%s=%s\nSTAGING_%s_EMAIL=%s\n' "$key" "$pw" "$(echo "$who" | tr a-z A-Z)" "$email" >> "$ENV_FILE"; fi
  q "do \$\$ declare uid uuid; begin
    select id into uid from auth.users where email = '$email';
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', '$email', extensions.crypt('$pw', extensions.gen_salt('bf')), now(), '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{\"fixture\":true}', now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', '$email', 'email_verified', true), 'email', uid::text, now(), now(), now());
    else
      update auth.users set encrypted_password = extensions.crypt('$pw', extensions.gen_salt('bf')) where id = uid;
    end if;
    insert into public.ops_operators (user_id, label, added_by) values (uid, 'staging $who (fixture)', 'seed-staff') on conflict (user_id) do nothing;
  end \$\$" >/dev/null
done
q "insert into public.ops_operator_permissions (user_id, permission, granted_by) select id, 'scheduling.admin', 'seed-staff' from auth.users where email = 'staging-admin@example.test' on conflict do nothing" >/dev/null
q "select u.email, (select count(*) from public.ops_operators o where o.user_id = u.id) as operator, (select string_agg(permission, ',') from public.ops_operator_permissions p where p.user_id = u.id) as permissions from auth.users u where u.email like 'staging-%@example.test' order by 1"
