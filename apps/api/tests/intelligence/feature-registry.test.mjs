import test from "node:test";
import assert from "node:assert/strict";

import {
  FeatureRegistryError,
  createFeatureRegistry,
  defineFeature,
  featureDefinitionHash,
  toFeatureDefinitionRow,
} from "../../src/lib/domain/intelligence/registry/feature-registry.js";
import { V1_FEATURE_SPECS, createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

/**
 * Pinned definition hashes. A failure here means a v1 definition changed
 * without a version bump: restore it, or define <key>@2 instead. Never edit a
 * pinned hash to make this pass.
 */
const PINNED = Object.freeze({
  "market.investor_count_trend_cell1km_6v6@1": "249e9f663ef674de453de3d075b859b61fca9b05ac3c2747793e2fd037d8a0f2",
  "market.investor_count_trend_r0_5mi_6v6@1": "fd2a12d5b38e6387ccc0ed558f778d52439275751e68eb9729b7c623ab7b122b",
  "market.investor_count_trend_r1mi_6v6@1": "cc28bbc8c1a417f2fc7b7eb2019b9dc9b763ba55c39f069b798f6290595bc4df",
  "market.investor_count_trend_r2mi_6v6@1": "dc5e7508c61273e888c8884b0536819ea478f298e6f912db4d5125062a217649",
  "market.investor_count_trend_zip_6v6@1": "f748539e76991e762827bff6227ec1536116d4563c7a29be2990c4e2cd02fbc8",
  "market.investor_purchases_cell1km_12m@1": "f8b7e5a10e207968c7605ec7a9375e6892b158b7210e8f54d3cc3d3b78679f20",
  "market.investor_purchases_cell1km_3m@1": "712ffab3f49387363c8e4bf447faee91a5d304d6dfbe6f0512c9a9ec5c75090f",
  "market.investor_purchases_cell1km_6m@1": "8dc3c63d723452188023a9cee341077b842c8ca5b9ea547210902a5d8c6d261e",
  "market.investor_purchases_r0_5mi_12m@1": "ad8b5646344c5c08b61d0e85db5d99905677164251313ae8d1d7062ceb4abe5e",
  "market.investor_purchases_r0_5mi_3m@1": "b3064c53eda9551da10da114e9a3f778616696924ebcd1e021efb5919683c89b",
  "market.investor_purchases_r0_5mi_6m@1": "6664e1ce060f5c12bde64234ad18a88568b376ef08ebbc1bcfa657e217aaf1df",
  "market.investor_purchases_r1mi_12m@1": "436d6dced4c2ad79667b554c7d4223949fc805fc44e95bbbc66faa29ce6cb80b",
  "market.investor_purchases_r1mi_3m@1": "908be83fc78b72defec499d101323d8e8407c4adc11efba2b8837d215db37923",
  "market.investor_purchases_r1mi_6m@1": "e1a59f4e72b4e12f2dc70b5358669e0472d9aa165d43d5a09f78c39cf4be0f2a",
  "market.investor_purchases_r2mi_12m@1": "ddad57393b2909f7b177022e3f0d722aa9de691910a862384ba79f8245e4f727",
  "market.investor_purchases_r2mi_3m@1": "01090a922f7aaa0df48c6223919bac0b77a1d1533beda3441d85832a342e57c1",
  "market.investor_purchases_r2mi_6m@1": "a90935ba9ee067eb07439d8f06d00749eb615bb48c9f3ddf730af613137d3e14",
  "market.investor_purchases_zip_12m@1": "90e6cabeaec129817d78cdff988f35d0a7b284233c1e07d682ed11b986b05c5d",
  "market.investor_purchases_zip_3m@1": "b38048a907aad0ae22f08c28dad7c8b041a01e666a837a629957f83611a3b791",
  "market.investor_purchases_zip_6m@1": "050c22740fd0338643f58998737bd342e0d4c23ea7596a8b33538fef770c759f",
  "market.investor_share_cell1km_12m@1": "6a3472a94780d854505da473b860a71685abb0583f3c84b35ac9f88d3f507ed6",
  "market.investor_share_cell1km_3m@1": "cd433840a6c19e72151da3202b47bb7fa7ed3237c9abb51ff8c4bd88e913658f",
  "market.investor_share_cell1km_6m@1": "da559f087b31334d289ff0a93c7fd2f634ff4fe6553b236298aac17229ceb9c7",
  "market.investor_share_r0_5mi_12m@1": "103ed21c75563c8fa92085424b12492f5b9c6091b046b3d63d653c9230004048",
  "market.investor_share_r0_5mi_3m@1": "36a5e5c47ff8a27f8d8831b95639479373d5403d933b355962f9a91ac347204e",
  "market.investor_share_r0_5mi_6m@1": "69fb88dbfc247b6aff14e51a87bce6286697fe9d9e50ef27381ce235466543fc",
  "market.investor_share_r1mi_12m@1": "6519131da60303f876a8eb17d821c7683044362c0e1432fce75dbf8401b31621",
  "market.investor_share_r1mi_3m@1": "78e6ed0cd2b0877caf4a47f8f24dea57fb66734b2860e53b02e3a3fc1503c86e",
  "market.investor_share_r1mi_6m@1": "4cbb40d6939c5ce714eb19e80c283626e0de292766e5df977781ab9ea99a20b5",
  "market.investor_share_r2mi_12m@1": "cd96c5287e859f4be830a9b77857cfbe7f8069c6288c8dc1a643e6c3d3f96b61",
  "market.investor_share_r2mi_3m@1": "83f0ed726866ffa3cfdf8d302862875a5e2d86d5e3092ae77ce0aa6c0f686d85",
  "market.investor_share_r2mi_6m@1": "c948ac259db43df3e56e03dab14e35f2f5626deaeca0592de8115dd1d6795912",
  "market.investor_share_trend_cell1km_6v6@1": "3d9c901da19506a0a9ba5f29eaf1253bcf6cff28fade8981f3179d0cc8c6a48a",
  "market.investor_share_trend_r0_5mi_6v6@1": "0977731d39ddb476aafb37963d8282fd5ac78cb1d6ed086eaa38451cde082be6",
  "market.investor_share_trend_r1mi_6v6@1": "f7e465e876cc95a922fad9fac638f988edded536d47c34cfd1b3525fd56e5047",
  "market.investor_share_trend_r2mi_6v6@1": "042a0210fb36a6b14c9587357d39833bcdeac2f44cc9a44a125b9916e8961c14",
  "market.investor_share_trend_zip_6v6@1": "155a44ca89f0025de2ea247328f7a85eec0169b33f01e6d1303e678b26761a8e",
  "market.investor_share_zip_12m@1": "8f70cb8f9e6eb93654de44fcbe33f2412503a3df99535c14e2c4130deb2d714e",
  "market.investor_share_zip_3m@1": "06b2e3e520be782753ef737aabbf1b3840f6b6f8e5ef9e8bf4366a07bfe47d1e",
  "market.investor_share_zip_6m@1": "55a55f379741acc0fa3cf41de7b147c88048f9c32693ff3da747b5599ce50fdb",
  "owner.absentee@1": "88cb2b3727db45ad31d61a37b8bc6fb84e6beb0e9c14fb23e0f7ab4418a62dcb",
  "owner.agent_persona@1": "32033ae7349de373284d585163b8dab604e3aaad463c0f789520b6f5cd0e4270",
  "owner.entity_class@1": "9515ad03d2a1b5ae147286929e9a1c45eaf29a09ba7ecfd0dc82b672a5f349aa",
  "owner.language@1": "46b8e6fadbfc777c8dfb66a897334295904e140b4458d49b8383fa9830b847cd",
  "property.asset_family@1": "bf31e4d5415a6560fc70fa9a4a4dee462cac779f5cab3ccb3f59a380efdc8e64",
  "property.bathrooms@1": "66005279575f37610877b75c1e7c5dc93da64e116413d84ab8da147c390e7c45",
  "property.bedrooms@1": "2ecf42cc7a9c5efd125ff8c48455fb9e750778e1d78139a805d3b33269794bbb",
  "property.living_sqft@1": "71198fc23936847e170ef024628aa3288986c477ab2d3f8b69db31c3d0a832d1",
  "property.market@1": "4c229205f964192103bbd8c7f4ac348a808afe73132912d3819557e457192cdf",
  "property.recorded_lien_count@1": "a66b6d27c9c28f00d453bf776f305ecf26f93d29a14c04e0196bcac79c1b6288",
  "property.recorded_mortgage_count@1": "637a653339f3cb908d8c3e07f7e3a147f53f96b322779ae39f08c3f6f5071b72",
  "property.unit_count@1": "7c9b83d57696e59b4e594be053551dc3d5cd5a8e5a3757889155d2e7ff234617",
  "property.year_built@1": "fa9f01842e8e9cfb690a5872e281de3972a392e15ac71cd16c52d53d99a6e4da",
  "property.years_since_last_recorded_sale@1": "4ea5f46ff60fc89cfd37340eb7958ba19b57773a966a544e84a351f37de357df",
  "prospect.age_band@1": "2fb9706aa974626b422dac83df83c93bc3ee5033fdd5d76a81d78729e0d08e22",
  "prospect.education_level@1": "3d2f2abdfb6f13b2e4890177b734b509582e38909b0b9832feb672d67425afe9",
  "prospect.gender@1": "d82782d34014749fee6fedb1a70cee83a2416f77c63dd0de211d1da6433eaa50",
  "prospect.household_income_band@1": "96e756dc4590eb7e334de22a3aed84ee11f0116859426e232bde262b36454697",
  "prospect.marital_status@1": "29081f6a91b02d40411a16d26c18df11e7f347d92b7b0c69a7c81749343e6b1b",
  "prospect.occupation_group@1": "60e5466331ad91db9d8b3eeba865d4f9fc7d68ffa54b5ebeebe66f81809209c3",
  "seller.days_since_last_touch@1": "a0426b9769e427b96b77532654e7c7b8d344d297516df87adf6fb43bb6152818",
  "seller.prior_delivered_count@1": "a13c2ace9dedbba630a3a5a1ec618012e9c126aa2f8ffefe486b2a1c6fbada64",
  "seller.prior_touch_count@1": "bb935c9ebc7d06f19426e9e5f9a66c73e4af40023cc97a0e78e76fd5179d0c48",
  "send.recipient_local_hour@1": "d0f687dee54cde3f51a3c432d2086eeef2f9245d253963943c406dffbcd76d90",
  "send.recipient_local_weekday@1": "e12556724d2407014a4e8c3788841db2314dfaa273b6bb11e77848240b358a5c",
  "template.template_id@1": "39b74486bca1b592419754943e273d119162e071b5a1372c1759dfccad287e1c",
  "template.use_case@1": "dff9686727563fcb4ed7b0737b999b2f75e1f665c76899f8536eb38a4d6d68bd",
  "seller_first_touch_all@1": "31d2359631897149375a7c5655d534f97b28ff36848d712091ac81f50851d900",
  "seller_first_touch_all@2": "2ede9ba6d8dc8f3da70777c78071b8ec2403c73b99ca3568b5d2c5a1711ab849",
  "seller_first_touch@1": "3ce39382ab59530b96ea1bf9093005a0cbf31cbeee7cf2655f6167a10df4e280",
  "seller_first_touch@2": "4918e0e0fd04c687323c521e02b136073792a92094adc7e3dd30ae93b4e50d78",
});

test("v1 definition hashes are pinned: a changed hash under the same version fails", () => {
  const registry = createV1Registry();
  const actual = {};
  for (const def of registry.list()) actual[def.id] = def.definitionHash;
  for (const set of registry.listSets()) actual[set.featureSetId] = set.definitionHash;
  assert.deepEqual(actual, PINNED);
});

test("definition_hash covers domain, pit class, fairness declarations, lineage and compute source", () => {
  const base = V1_FEATURE_SPECS.find((s) => s.key === "property.unit_count");
  const hash = featureDefinitionHash(base);
  const variants = [
    { domain: "financial_title" },
    { fairnessClass: "personal_attribute" },
    { statedFact: true },
    { pitClass: "event_time" },
    { scope: "deal" },
    { valueType: "number" },
    { lineage: { ...base.lineage, calc: "different calculation" } },
    { compute: ({ read }) => read("property").length },
  ];
  for (const change of variants) {
    assert.notEqual(featureDefinitionHash({ ...base, ...change }), hash, JSON.stringify(Object.keys(change)));
  }
  // mode/owner/freshness are operational metadata, not meaning (arch §3.1 hash fields)
  assert.equal(featureDefinitionHash({ ...base, owner: "someone-else" }), hash);
});

test("a redefinition under the same key@version is rejected; the same definition is idempotent", () => {
  const registry = createFeatureRegistry();
  const spec = V1_FEATURE_SPECS.find((s) => s.key === "property.year_built");
  registry.register(spec);
  assert.equal(registry.register(spec).id, "property.year_built@1");
  assert.throws(
    () => registry.register({ ...spec, compute: ({ read }) => read("property").length }),
    (error) => error instanceof FeatureRegistryError && error.code === "REDEFINITION",
  );
  registry.register({ ...spec, version: 2, compute: ({ read }) => read("property").length });
  assert.ok(registry.has("property.year_built", 2));
});

test("domain is required and must be one of the owner's five domains", () => {
  const spec = V1_FEATURE_SPECS.find((s) => s.key === "property.year_built");
  const withoutDomain = { ...spec };
  delete withoutDomain.domain;
  assert.throws(() => defineFeature(withoutDomain), /domain must be one of property, ownership_prospect, financial_title, company_relationship, operational/);
  assert.throws(() => defineFeature({ ...spec, domain: "market" }), /domain must be one of/);
});

test("historical training sets refuse decision_snapshot_only features", () => {
  const registry = createV1Registry();
  for (const member of ["owner.absentee@1", "property.recorded_lien_count@1"]) {
    assert.throws(
      () => registry.defineSet({ name: "with_snapshot_only", version: 1, members: ["property.year_built@1", member] }),
      (error) => error.code === "PIT_CLASS_NOT_HISTORICAL",
      member,
    );
  }
  const online = registry.defineSet({
    name: "seller_first_touch_online",
    version: 1,
    purpose: "online",
    members: ["property.year_built@1", "owner.absentee@1"],
  });
  assert.equal(online.purpose, "online");
  assert.throws(
    () => defineFeature({ ...V1_FEATURE_SPECS.find((s) => s.key === "owner.absentee"), mode: "both" }),
    /decision_snapshot_only features are online-only/,
  );
});

test("mirror rows carry domain and fairness class for intelligence.feature_definitions", () => {
  const registry = createV1Registry();
  const row = toFeatureDefinitionRow(registry.get("prospect.age_band", 1));
  assert.equal(row.domain, "ownership_prospect");
  assert.equal(row.fairness_class, "personal_attribute");
  assert.equal(row.pit_class, "static_fact");
  assert.equal(row.definition_hash.length, 64);
  assert.equal(toFeatureDefinitionRow(registry.get("prospect.gender", 1)).fairness_class, "personal_attribute");
  const absentee = toFeatureDefinitionRow(registry.get("owner.absentee", 1));
  assert.equal(absentee.freshness_sla, "300 seconds");
  assert.equal(registry.toFeatureSetRows().length, 4);
});
