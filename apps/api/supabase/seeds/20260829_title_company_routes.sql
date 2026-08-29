-- ════════════════════════════════════════════════════════════════════════
-- Title company + market route seed — REAL OPERATOR VENDOR DATA.
--
-- Source: operator-supplied title_companies.csv (2026-08-29), 53 markets.
-- This replaces TEMPLATE_title_company_routes.sql as the actual seed; the
-- template remains as documentation of the shape.
--
-- Market labels below are CANONICAL (post-alias), produced by running each CSV
-- market through canonicalizeMarket() — the same function the router uses at
-- selection time — so a seeded route is guaranteed to be findable. Exactly one
-- alias fired: "Inland Empire CA" -> "Riverside, CA". All 53 canonicalize
-- cleanly with ZERO collisions and ZERO missing new_order_email.
--
-- title_company_key is <company>__<market> because several firms serve multiple
-- markets from different desks with DIFFERENT order emails (Patten Title
-- Houston vs San Antonio, WFG Spokane vs NorCal vs Albuquerque, Investors Title
-- KC vs St. Louis vs Charlotte, Title Alliance Richmond vs Norfolk). Keying by
-- company alone would collapse those and mail the wrong desk.
--
-- ONLY PRIMARIES (route_rank 1) ARE SEEDED — the CSV supplies no backup column.
-- Backups can be added later as route_rank 2; nothing is invented here, so a
-- market whose primary becomes unusable correctly fails closed.
--
-- Idempotent: companies UPSERT on title_company_key; routes are guarded by
-- ON CONFLICT DO NOTHING against uq_title_route_market_rank.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO public.title_companies
  (title_company_key, name, contact_manager, new_order_email, phone, source_system, source_version, metadata)
VALUES
  ('lenders_choice_escrow__riverside_ca', 'Lenders Choice Escrow', 'Vicki Hoffstatter', 'vicki.hoffstatter@lenderschoiceescrow.com', '+19205600000', 'operator_csv_20260829', 'v1', '{"address":"1 City Blvd W Ste 1925 Orange CA 92868","underwriter":"WFG National","rating":"4.3","notes":"CA Sub-To/Creative expert.","csv_market":"Inland Empire CA"}'::jsonb),
  ('wfg_national_title__spokane_wa', 'WFG National Title', 'Investor Desk', 'spokane@wfgtitle.com', '+15093273131', 'operator_csv_20260829', 'v1', '{"address":"12929 E Sprague Ave #100 Spokane WA 99216","underwriter":"Williston Financial","rating":"4.5","notes":"Fast RON capabilities.","csv_market":"Spokane WA"}'::jsonb),
  ('lenders_choice_escrow__los_angeles_ca', 'Lenders Choice Escrow', 'Vicki Hoffstatter', 'vicki.hoffstatter@lenderschoiceescrow.com', '+19205600000', 'operator_csv_20260829', 'v1', '{"address":"1 City Blvd W Ste 1925 Orange CA 92868","underwriter":"WFG National","rating":"4.3","notes":"Experienced with messy liens.","csv_market":"Los Angeles CA"}'::jsonb),
  ('marina_title__tampa_fl', 'Marina Title', 'Jennie Farshchian', 'info@marinatitle.com', '+18133670129', 'operator_csv_20260829', 'v1', '{"address":"14502 N Dale Mabry Hwy #200 Tampa FL 33618","underwriter":"Old Republic","rating":"4.9","notes":"Novations & Attorney-Led.","csv_market":"Tampa FL"}'::jsonb),
  ('nevada_state_title__las_vegas_nv', 'Nevada State Title', 'Investor Dept', 'info@nevadastatetitle.com', '+17028359610', 'operator_csv_20260829', 'v1', '{"address":"777 N Rainbow Blvd #140 Las Vegas NV 89107","underwriter":"Westcor","rating":"4.2","notes":"Double Closes expert.","csv_market":"Las Vegas NV"}'::jsonb),
  ('patten_title__houston_tx', 'Patten Title', 'Luxe Team', 'orders@pattentitle.com', '+18326151100', 'operator_csv_20260829', 'v1', '{"address":"10100 Katy Fwy #105 Houston TX 77043","underwriter":"First American","rating":"4.7","notes":"TX Creative Compliance.","csv_market":"Houston TX"}'::jsonb),
  ('the_hawes_law_firm__clayton_ga', 'The Hawes Law Firm', 'Pre-Closer Dept', 'closings@thehaweslawfirm.com', '+17704158585', 'operator_csv_20260829', 'v1', '{"address":"100 Crescent Centre Pkwy #210 Tucker GA 30084","underwriter":"Fidelity National","rating":"4.6","notes":"GA Attorney State focus.","csv_market":"Clayton GA"}'::jsonb),
  ('investors_title__kansas_city_mo', 'Investors Title', 'Manager', 'kcorders@invtitle.com', '+18163632222', 'operator_csv_20260829', 'v1', '{"address":"219 S Central Ave Saint Louis MO 63105","underwriter":"Old Republic","rating":"4.4","notes":"MO Land Trust specialists.","csv_market":"Kansas City MO"}'::jsonb),
  ('knight_barry_title__milwaukee_wi', 'Knight Barry Title', 'Closing Team', 'info@knightbarry.com', '+14142718400', 'operator_csv_20260829', 'v1', '{"address":"201 E Pittsburgh Ave Ste 200 Milwaukee WI 53204","underwriter":"First American","rating":"4.5","notes":"Handles messy probate well.","csv_market":"Milwaukee WI"}'::jsonb),
  ('titlesmart__minneapolis_mn', 'TitleSmart', 'Cindy Koebele', 'cindy@titlesmart.com', '+16517793075', 'operator_csv_20260829', 'v1', '{"address":"2233 Hamline Ave N Ste 101 Roseville MN 55113","underwriter":"Old Republic","rating":"4.8","notes":"Speed & 48-hr turnaround.","csv_market":"Minneapolis MN"}'::jsonb),
  ('investors_title_services__chicago_il', 'Investors Title Services', 'Joe / Dan', 'joe@investorstitleservicesllc.com', '+18474439676', 'operator_csv_20260829', 'v1', '{"address":"122 W Main St Fl 2 West Dundee IL 60118","underwriter":"Chicago Title","rating":"4.8","notes":"Blind HUD/Wholesale privacy.","csv_market":"Chicago IL"}'::jsonb),
  ('pittman_title_and_escrow__philadelphia_pa', 'Pittman Title & Escrow', 'Stephen Pittman', 'stephen@pittmantitle.com', '+16095514830', 'operator_csv_20260829', 'v1', '{"address":"1500 Market St Philadelphia PA 19102","underwriter":"WFG National","rating":"4.9","notes":"Investor-owned firm.","csv_market":"Philadelphia PA"}'::jsonb),
  ('lakeside_title__baltimore_md', 'Lakeside Title', 'Manager', 'info@lakesidetitle.com', '+14109921070', 'operator_csv_20260829', 'v1', '{"address":"9200 Old Annapolis Rd Ste 200 Columbia MD 21045","underwriter":"Old Republic","rating":"4.4","notes":"Ground Rent specialists.","csv_market":"Baltimore MD"}'::jsonb),
  ('title_one_inc__detroit_mi', 'Title One Inc', 'Closing Team', 'info@titleoneinc.net', '+12486082700', 'operator_csv_20260829', 'v1', '{"address":"4 Parklane Blvd Ste 330 Dearborn MI 48126","underwriter":"First American","rating":"4.7","notes":"Flash Closings/Assign.","csv_market":"Detroit MI"}'::jsonb),
  ('empora_title__cleveland_oh', 'Empora Title', 'Digital Team', 'orders@emporatitle.com', '+18555367672', 'operator_csv_20260829', 'v1', '{"address":"145 E Rich St Fl 4 Columbus OH 43215","underwriter":"Westcor","rating":"4.8","notes":"Flat-Fee Tech-First.","csv_market":"Cleveland OH"}'::jsonb),
  ('stewart_title__omaha_ne', 'Stewart Title', 'Carrie Sorensen', 'carrie.sorensen@stewart.com', '+14028844500', 'operator_csv_20260829', 'v1', '{"address":"13321 California St #100 Omaha NE 68154","underwriter":"Stewart Title","rating":"4.1","notes":"Investor Desk available.","csv_market":"Omaha NE"}'::jsonb),
  ('block_longo_lamarca__rochester_ny', 'Block Longo LaMarca', 'Chris Hills', 'chills@blockandlongo.com', '+15856973300', 'operator_csv_20260829', 'v1', '{"address":"1173 Pittsford Victor Rd Ste 220 Pittsford NY 14534","underwriter":"Stewart Title","rating":"4.5","notes":"NY Assignment expert.","csv_market":"Rochester NY"}'::jsonb),
  ('title_alliance__richmond_va', 'Title Alliance', 'Manager', 'richmond@titlealliance.com', '+18045217890', 'operator_csv_20260829', 'v1', '{"address":"100 Concourse Blvd #101 Glen Allen VA 23059","underwriter":"North American","rating":"4.3","notes":"Payoff Coordination.","csv_market":"Richmond VA"}'::jsonb),
  ('inwest_title__salt_lake_city_ut', 'Inwest Title', 'Investor Desk', 'slc@inwesttitle.com', '+18014860150', 'operator_csv_20260829', 'v1', '{"address":"1100 East 6600 South #120 SLC UT 84121","underwriter":"First American","rating":"4.4","notes":"Fix & Flip Speed.","csv_market":"Salt Lake City UT"}'::jsonb),
  ('security_1st_title__wichita_ks', 'Security 1st Title', 'Closing Dept', 'info@security1st.com', '+13162628261', 'operator_csv_20260829', 'v1', '{"address":"727 N Waco Ave #300 Wichita KS 67203","underwriter":"Old Republic","rating":"4.2","notes":"Standard Wholesale desk.","csv_market":"Wichita KS"}'::jsonb),
  ('pittman_title_and_escrow__pittsburgh_pa', 'Pittman Title & Escrow', 'Stephen Pittman', 'stephen@pittmantitle.com', '+16095514830', 'operator_csv_20260829', 'v1', '{"address":"1500 Market St Philadelphia PA 19102","underwriter":"WFG National","rating":"4.9","notes":"PA creative specialist.","csv_market":"Pittsburgh PA"}'::jsonb),
  ('patten_title__san_antonio_tx', 'Patten Title', 'Manager', 'saorders@pattentitle.com', '+12104441100', 'operator_csv_20260829', 'v1', '{"address":"17503 La Cantera Pkwy #102 San Antonio TX 78257","underwriter":"First American","rating":"4.7","notes":"Sub-To experts.","csv_market":"San Antonio TX"}'::jsonb),
  ('title_alliance__portsmouth_va', 'Title Alliance', 'Manager', 'norfolk@titlealliance.com', '+17574667333', 'operator_csv_20260829', 'v1', '{"address":"100 Concourse Blvd #101 Glen Allen VA 23059","underwriter":"North American","rating":"4.3","notes":"Mobile Notary focus.","csv_market":"Portsmouth VA"}'::jsonb),
  ('bella_title__cincinnati_oh', 'Bella Title', 'Closing Team', 'info@bella-title.com', '+15134000033', 'operator_csv_20260829', 'v1', '{"address":"7633 Montgomery Rd Unit 6 Cincinnati OH 45236","underwriter":"Westcor","rating":"4.6","notes":"OH/KY Licensed.","csv_market":"Cincinnati OH"}'::jsonb),
  ('true_title_partners__el_paso_tx', 'True Title Partners', 'Manager', 'info@trueelpaso.com', '+19152284708', 'operator_csv_20260829', 'v1', '{"address":"1401 Montana Ave El Paso TX 79902","underwriter":"WFG National","rating":"4.4","notes":"High Volume Border Deals.","csv_market":"El Paso TX"}'::jsonb),
  ('jett_title__louisville_ky', 'Jett Title', 'Kathy Jett', 'kathy@jetttitle.com', '+15028951212', 'operator_csv_20260829', 'v1', '{"address":"2560 Richmond Rd Ste 100 Lexington KY 40509","underwriter":"Old Republic","rating":"4.5","notes":"KY Assignment expert.","csv_market":"Louisville KY"}'::jsonb),
  ('ambassador_title__des_moines_ia', 'Ambassador Title', 'C. Clure', 'cclure@ambassadortitle.com', '+15152780623', 'operator_csv_20260829', 'v1', '{"address":"2560 73rd Street Des Moines IA 50322","underwriter":"Stewart Title","rating":"4.1","notes":"IA Title Guaranty knowledge.","csv_market":"Des Moines IA"}'::jsonb),
  ('superior_title__columbus_oh', 'Superior Title', 'Manager', 'orders@superiortitleohio.com', '+16143261900', 'operator_csv_20260829', 'v1', '{"address":"145 E Rich St Fl 4 Columbus OH 43215","underwriter":"First American","rating":"4.4","notes":"Double Closings.","csv_market":"Columbus OH"}'::jsonb),
  ('wfg_national_title__albuquerque_nm', 'WFG National Title', 'T. Manzanares', 'tmanzanares@wfgtitle.com', '+15055355275', 'operator_csv_20260829', 'v1', '{"address":"5600 Eubank Blvd NE Albuquerque NM 87111","underwriter":"Williston Financial","rating":"4.4","notes":"Remote/RON specialists.","csv_market":"Albuquerque NM"}'::jsonb),
  ('capital_title__austin_tx', 'Capital Title', 'Manager', 'mjohn@capitaltitlencs.com', '+15123290122', 'operator_csv_20260829', 'v1', '{"address":"1523 W Koenig Lane Austin TX 78756","underwriter":"Shaddock National","rating":"4.6","notes":"Agile investor team.","csv_market":"Austin TX"}'::jsonb),
  ('national_land_tenure__providence_ri', 'National Land Tenure', 'Closing Desk', 'info@nltusa.com', '+14012741111', 'operator_csv_20260829', 'v1', '{"address":"10 Orms St Providence RI 02904","underwriter":"Fidelity National","rating":"4.2","notes":"New England coverage.","csv_market":"Providence RI"}'::jsonb),
  ('titan_title__tulsa_ok', 'Titan Title', 'Manager', 'info@titantitleok.com', '+19184810500', 'operator_csv_20260829', 'v1', '{"address":"10016 S Mingo Rd Tulsa OK 74133","underwriter":"First American","rating":"4.3","notes":"REIA Partner.","csv_market":"Tulsa OK"}'::jsonb),
  ('hutchins_law_firm__raleigh_nc', 'Hutchins Law Firm', 'Manager', 'info@hutchinslawfirm.com', '+19197191111', 'operator_csv_20260829', 'v1', '{"address":"4317 Ramsey St Fayetteville NC 28311","underwriter":"Old Republic","rating":"4.5","notes":"NC Law Specialists.","csv_market":"Raleigh NC"}'::jsonb),
  ('pioneer_title__boise_id', 'Pioneer Title', 'Manager', 'boise@pioneertitleco.com', '+12083772700', 'operator_csv_20260829', 'v1', '{"address":"1211 W Myrtle St #100 Boise ID 83702","underwriter":"Pioneer Holding","rating":"4.6","notes":"Independent & Fast.","csv_market":"Boise ID"}'::jsonb),
  ('crespo_law_firm__hartford_ct', 'Crespo Law Firm', 'Leticia Crespo', 'leticia@crespolawfirm.com', '+18602472470', 'operator_csv_20260829', 'v1', '{"address":"44 Lyon Terrace Bridgeport CT 06604","underwriter":"Old Republic","rating":"4.4","notes":"CT Assignment expert.","csv_market":"Hartford CT"}'::jsonb),
  ('closed_title__phoenix_az', 'CLOSED Title', 'Jeena Patel', 'order@closedtitle.com', '+18004057150', 'operator_csv_20260829', 'v1', '{"address":"2150 E Germann Rd Chandler AZ 85286","underwriter":"WFG National","rating":"4.8","notes":"Sub-To specialist.","csv_market":"Phoenix AZ"}'::jsonb),
  ('crescent_title__new_orleans_la', 'Crescent Title', 'Succession Dept', 'info@crescenttitle.com', '+15048283535', 'operator_csv_20260829', 'v1', '{"address":"7835 Maple St New Orleans LA 70118","underwriter":"Stewart Title","rating":"4.5","notes":"Probate/Succession focus.","csv_market":"New Orleans LA"}'::jsonb),
  ('fidelity_national__jacksonville_fl', 'Fidelity National', 'Kattie Eaton', 'kattie.eaton@fnf.com', '+19048548100', 'operator_csv_20260829', 'v1', '{"address":"601 Riverside Ave Jacksonville FL 32204","underwriter":"Fidelity National","rating":"4.2","notes":"Stable investor desk.","csv_market":"Jacksonville FL"}'::jsonb),
  ('south_oak_title__birmingham_al', 'South Oak Title', 'Manager', 'info@southoaktitle.com', '+12059838100', 'operator_csv_20260829', 'v1', '{"address":"2870 Old Rocky Ridge Rd #160 Birmingham AL 35243","underwriter":"Old Republic","rating":"4.6","notes":"Video/Mobile Closings.","csv_market":"Birmingham AL"}'::jsonb),
  ('titan_title__oklahoma_city_ok', 'Titan Title', 'Manager', 'info@titantitleok.com', '+14056070041', 'operator_csv_20260829', 'v1', '{"address":"14001 N Pennsylvania Ave OKC OK 73134","underwriter":"First American","rating":"4.3","notes":"OK Speed/Wholesale.","csv_market":"Oklahoma City OK"}'::jsonb),
  ('wfg_national_title__sacramento_ca', 'WFG National Title', 'NorCal Team', 'csnorcal@wfgtitle.com', '+19162821555', 'operator_csv_20260829', 'v1', '{"address":"3400 Douglas Blvd #150 Roseville CA 95661","underwriter":"Williston Financial","rating":"4.4","notes":"Wholesale Hub.","csv_market":"Sacramento CA"}'::jsonb),
  ('empire_west_title__tucson_az', 'Empire West Title', 'Nohemi Medina', 'nohemi@ewtaz.com', '+15202092200', 'operator_csv_20260829', 'v1', '{"address":"2440 E Broadway Blvd Tucson AZ 85719","underwriter":"First American","rating":"4.7","notes":"Sub-To Authority.","csv_market":"Tucson AZ"}'::jsonb),
  ('key_title_group__dallas_tx', 'Key Title Group', 'Manager', 'info@keytitlegroupdfw.com', '+12143822110', 'operator_csv_20260829', 'v1', '{"address":"900 S Capital of Texas Hwy #100 Austin TX 78746","underwriter":"Independent","rating":"4.6","notes":"Agile/Same-Day Closings.","csv_market":"Dallas TX"}'::jsonb),
  ('ticor_title__bakersfield_ca', 'Ticor Title', 'Investor Desk', 'kern@ticortitle.com', '+16618477000', 'operator_csv_20260829', 'v1', '{"address":"10000 Stockdale Hwy Ste 101 Bakersfield CA 93311","underwriter":"Fidelity National","rating":"4.1","notes":"Central Valley Desk.","csv_market":"Bakersfield CA"}'::jsonb),
  ('wfg_national_title__fresno_ca', 'WFG National Title', 'NorCal Team', 'csnorcal@wfgtitle.com', '+15596038532', 'operator_csv_20260829', 'v1', '{"address":"3400 Douglas Blvd #150 Roseville CA 95661","underwriter":"Williston Financial","rating":"4.4","notes":"High-Volume Assignments.","csv_market":"Fresno CA"}'::jsonb),
  ('investors_title__saint_louis_mo', 'Investors Title', 'Manager', 'stlouis@invtitle.com', '+13148620303', 'operator_csv_20260829', 'v1', '{"address":"219 S Central Ave Saint Louis MO 63105","underwriter":"Old Republic","rating":"4.4","notes":"Subject-To Experts.","csv_market":"Saint Louis MO"}'::jsonb),
  ('meridian_title__indianapolis_in', 'Meridian Title', 'Investor Dept', 'info@meridiantitle.com', '+13175775930', 'operator_csv_20260829', 'v1', '{"address":"1401 N Pennsylvania Ave OKC OK 73134","underwriter":"First American","rating":"4.6","notes":"REIA Wholesaler favorite.","csv_market":"Indianapolis IN"}'::jsonb),
  ('marina_title__miami_fl', 'Marina Title', 'Jennie Farshchian', 'info@marinatitle.com', '+13054017689', 'operator_csv_20260829', 'v1', '{"address":"20801 Biscayne Blvd #401 Aventura FL 33180","underwriter":"Old Republic","rating":"4.9","notes":"Luxury/Novation specialist.","csv_market":"Miami FL"}'::jsonb),
  ('blueprint_title__memphis_tn', 'Blueprint Title', 'Support Team', 'support@blueprinttitle.com', '+19012035110', 'operator_csv_20260829', 'v1', '{"address":"401 Church St Ste 1710 Nashville TN 37219","underwriter":"Old Republic","rating":"4.5","notes":"Digital/Remote focus.","csv_market":"Memphis TN"}'::jsonb),
  ('bagwell_and_associates__atlanta_ga', 'Bagwell & Associates', 'Manager', 'closings@thehaweslawfirm.com', '+14042641600', 'operator_csv_20260829', 'v1', '{"address":"2931 Piedmont Rd NE Ste C Atlanta GA 30305","underwriter":"Fidelity National","rating":"4.6","notes":"GA Probate/Creative.","csv_market":"Atlanta GA"}'::jsonb),
  ('celebration_title__orlando_fl', 'Celebration Title', 'Allyssa', 'allyssa@celebrationtitle.com', '+14075660151', 'operator_csv_20260829', 'v1', '{"address":"211 E Colonial Dr Orlando FL 32801","underwriter":"First American","rating":"4.7","notes":"High Speed Wholesaling.","csv_market":"Orlando FL"}'::jsonb),
  ('blueprint_title__nashville_tn', 'Blueprint Title', 'Support Team', 'support@blueprinttitle.com', '+16156221010', 'operator_csv_20260829', 'v1', '{"address":"401 Church St Ste 1710 Nashville TN 37219","underwriter":"Old Republic","rating":"4.5","notes":"Simultaneous Closings.","csv_market":"Nashville TN"}'::jsonb),
  ('investors_title__charlotte_nc', 'Investors Title', 'Closing Team', 'charlotte@invtitle.com', '+17043358124', 'operator_csv_20260829', 'v1', '{"address":"5925 Carnegie Blvd Ste 550 Charlotte NC 28209","underwriter":"Investors Title Ins","rating":"4.3","notes":"Regional Underwriter.","csv_market":"Charlotte NC"}'::jsonb)
ON CONFLICT (title_company_key) DO UPDATE SET
  name=EXCLUDED.name, contact_manager=EXCLUDED.contact_manager,
  new_order_email=EXCLUDED.new_order_email, phone=EXCLUDED.phone,
  source_system=EXCLUDED.source_system, source_version=EXCLUDED.source_version,
  metadata=EXCLUDED.metadata, is_active=true, updated_at=now();

INSERT INTO public.title_company_market_routes (market, title_company_key, route_rank, route_version)
VALUES
  ('Riverside, CA', 'lenders_choice_escrow__riverside_ca', 1, 'v1'),
  ('Spokane, WA', 'wfg_national_title__spokane_wa', 1, 'v1'),
  ('Los Angeles, CA', 'lenders_choice_escrow__los_angeles_ca', 1, 'v1'),
  ('Tampa, FL', 'marina_title__tampa_fl', 1, 'v1'),
  ('Las Vegas, NV', 'nevada_state_title__las_vegas_nv', 1, 'v1'),
  ('Houston, TX', 'patten_title__houston_tx', 1, 'v1'),
  ('Clayton, GA', 'the_hawes_law_firm__clayton_ga', 1, 'v1'),
  ('Kansas City, MO', 'investors_title__kansas_city_mo', 1, 'v1'),
  ('Milwaukee, WI', 'knight_barry_title__milwaukee_wi', 1, 'v1'),
  ('Minneapolis, MN', 'titlesmart__minneapolis_mn', 1, 'v1'),
  ('Chicago, IL', 'investors_title_services__chicago_il', 1, 'v1'),
  ('Philadelphia, PA', 'pittman_title_and_escrow__philadelphia_pa', 1, 'v1'),
  ('Baltimore, MD', 'lakeside_title__baltimore_md', 1, 'v1'),
  ('Detroit, MI', 'title_one_inc__detroit_mi', 1, 'v1'),
  ('Cleveland, OH', 'empora_title__cleveland_oh', 1, 'v1'),
  ('Omaha, NE', 'stewart_title__omaha_ne', 1, 'v1'),
  ('Rochester, NY', 'block_longo_lamarca__rochester_ny', 1, 'v1'),
  ('Richmond, VA', 'title_alliance__richmond_va', 1, 'v1'),
  ('Salt Lake City, UT', 'inwest_title__salt_lake_city_ut', 1, 'v1'),
  ('Wichita, KS', 'security_1st_title__wichita_ks', 1, 'v1'),
  ('Pittsburgh, PA', 'pittman_title_and_escrow__pittsburgh_pa', 1, 'v1'),
  ('San Antonio, TX', 'patten_title__san_antonio_tx', 1, 'v1'),
  ('Portsmouth, VA', 'title_alliance__portsmouth_va', 1, 'v1'),
  ('Cincinnati, OH', 'bella_title__cincinnati_oh', 1, 'v1'),
  ('El Paso, TX', 'true_title_partners__el_paso_tx', 1, 'v1'),
  ('Louisville, KY', 'jett_title__louisville_ky', 1, 'v1'),
  ('Des Moines, IA', 'ambassador_title__des_moines_ia', 1, 'v1'),
  ('Columbus, OH', 'superior_title__columbus_oh', 1, 'v1'),
  ('Albuquerque, NM', 'wfg_national_title__albuquerque_nm', 1, 'v1'),
  ('Austin, TX', 'capital_title__austin_tx', 1, 'v1'),
  ('Providence, RI', 'national_land_tenure__providence_ri', 1, 'v1'),
  ('Tulsa, OK', 'titan_title__tulsa_ok', 1, 'v1'),
  ('Raleigh, NC', 'hutchins_law_firm__raleigh_nc', 1, 'v1'),
  ('Boise, ID', 'pioneer_title__boise_id', 1, 'v1'),
  ('Hartford, CT', 'crespo_law_firm__hartford_ct', 1, 'v1'),
  ('Phoenix, AZ', 'closed_title__phoenix_az', 1, 'v1'),
  ('New Orleans, LA', 'crescent_title__new_orleans_la', 1, 'v1'),
  ('Jacksonville, FL', 'fidelity_national__jacksonville_fl', 1, 'v1'),
  ('Birmingham, AL', 'south_oak_title__birmingham_al', 1, 'v1'),
  ('Oklahoma City, OK', 'titan_title__oklahoma_city_ok', 1, 'v1'),
  ('Sacramento, CA', 'wfg_national_title__sacramento_ca', 1, 'v1'),
  ('Tucson, AZ', 'empire_west_title__tucson_az', 1, 'v1'),
  ('Dallas, TX', 'key_title_group__dallas_tx', 1, 'v1'),
  ('Bakersfield, CA', 'ticor_title__bakersfield_ca', 1, 'v1'),
  ('Fresno, CA', 'wfg_national_title__fresno_ca', 1, 'v1'),
  ('Saint Louis, MO', 'investors_title__saint_louis_mo', 1, 'v1'),
  ('Indianapolis, IN', 'meridian_title__indianapolis_in', 1, 'v1'),
  ('Miami, FL', 'marina_title__miami_fl', 1, 'v1'),
  ('Memphis, TN', 'blueprint_title__memphis_tn', 1, 'v1'),
  ('Atlanta, GA', 'bagwell_and_associates__atlanta_ga', 1, 'v1'),
  ('Orlando, FL', 'celebration_title__orlando_fl', 1, 'v1'),
  ('Nashville, TN', 'blueprint_title__nashville_tn', 1, 'v1'),
  ('Charlotte, NC', 'investors_title__charlotte_nc', 1, 'v1')
ON CONFLICT DO NOTHING;

-- ── Applied + verified in production 2026-08-29 ─────────────────────────────
-- 53 companies upserted, 53 rank-1 routes inserted, 53 distinct canonical
-- markets, 0 collisions, 0 missing new_order_email, 0 orphan routes.
-- Re-running is a no-op (idempotent: re-insert added 0 rows).
--
-- Coverage against real property data: 115,740 of 124,047 market-bearing
-- properties (93.3%) land in a routed market. ("Inland Empire, CA" counts as
-- routed: it canonicalizes to "Riverside, CA" via MARKET_ALIASES.)
--
-- KNOWN UNROUTED (these correctly fail closed with title_route_unavailable;
-- none are fabricated around):
--   * Stockton, CA (~1,645) and Modesto, CA (~1,002) — no vendor supplied.
--   * Norfolk, VA (~650) — the CSV supplies "Portsmouth VA", whose order email
--     is norfolk@titlealliance.com, so the same firm plausibly covers Norfolk,
--     but the market labels differ. Needs an operator decision (add a Norfolk
--     route or an alias); NOT assumed here.
--   * Tuscon, AZ (~1,131) — a MISSPELLING in the property data. The vendor CSV
--     correctly says "Tucson AZ" and Tucson, AZ IS routed. This is a
--     property-data quality bug, not a vendor gap. Deliberately NOT patched via
--     MARKET_ALIASES here, because that registry also drives SMS sender
--     routing and must not be changed as a side effect of title seeding.
--
-- BACKUPS: the CSV supplies primaries only, so every route is rank 1. No backup
-- was invented. Add rank-2 routes when real backup vendors exist; until then a
-- market whose primary becomes unusable fails closed rather than mis-routing.
