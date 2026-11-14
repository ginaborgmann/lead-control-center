create function public.fill_reonic_partner_teams()
returns integer language sql security invoker set search_path=''
as $$
  with recursive ancestry as (
    select id as descendant, parent_id as ancestor, array[id] as visited
    from public.reonic_teams where active and parent_id is not null
    union all
    select a.descendant,t.parent_id,a.visited || t.id
    from ancestry a join public.reonic_teams t on t.id=a.ancestor
    where t.active and t.parent_id is not null and not t.id=any(a.visited)
  ), memberships as (
    select p.id as partner_id,t.id as team_id,cardinality(t.leader_ids)>0 as has_leader
    from public.sales_partners p join public.reonic_teams t on t.active
      and (p.reonic_user_id=any(t.member_ids) or p.reonic_user_id=any(t.leader_ids))
    where p.reonic_present and not p.reonic_team_optional and p.reonic_team_id is null
  ), choices as (
    select m.partner_id,min(m.team_id) as team_id
    from memberships m
    where not exists (
      select 1 from memberships child join ancestry a on a.descendant=child.team_id
      where child.partner_id=m.partner_id and a.ancestor=m.team_id and child.team_id<>m.team_id
    )
    group by m.partner_id having count(*)=1 and bool_and(m.has_leader)
  ), changed as (
    update public.sales_partners p set reonic_team_id=c.team_id
    from choices c where p.id=c.partner_id and p.reonic_team_id is null and not p.reonic_team_optional
    returning p.id
  )
  select count(*)::integer from changed;
$$;
revoke execute on function public.fill_reonic_partner_teams() from public,anon,authenticated;
grant execute on function public.fill_reonic_partner_teams() to service_role;