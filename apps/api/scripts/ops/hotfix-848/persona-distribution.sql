-- READ-ONLY. Source of src/lib/domain/outbound/outbound-persona-distribution.generated.js
-- (the existing master_owners persona assignment, overall and per best_language).
select json_build_object(
  'by_language', (select json_object_agg(lang, d) from (
      select lang, json_object_agg(agent_persona, n order by n desc) d
        from (select coalesce(nullif(trim(best_language),''),'_none') lang, trim(agent_persona) agent_persona, count(*) n
                from master_owners where nullif(trim(agent_persona),'') is not null group by 1,2) s
       group by lang) x),
  'all', (select json_object_agg(agent_persona, n order by n desc) from (
      select trim(agent_persona) agent_persona, count(*) n from master_owners
       where nullif(trim(agent_persona),'') is not null group by 1) y),
  'owners', (select count(*) from master_owners where nullif(trim(agent_persona),'') is not null));
