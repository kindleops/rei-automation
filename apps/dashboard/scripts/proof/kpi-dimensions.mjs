import fs from 'fs';

console.log('🧪 Starting KPI Dimensions Proof...\n');

const sqlFile = 'supabase/migrations/20260511000006_performance_intelligence_views.sql';

if (fs.existsSync(sqlFile)) {
    const content = fs.readFileSync(sqlFile, 'utf8');
    const requiredViews = [
        'template_performance_kpis_v',
        'number_performance_kpis_v',
        'market_performance_kpis_v',
        'property_type_performance_kpis_v',
        'seller_signal_performance_kpis_v',
        'property_signal_performance_kpis_v',
        'owner_type_performance_kpis_v',
        'stage_performance_kpis_v',
        'touch_performance_kpis_v',
        'language_performance_kpis_v',
        'performance_outliers_v'
    ];

    let passed = true;
    for (const view of requiredViews) {
        if (content.includes(view)) {
            console.log(`✅ ${view} exists.`);
        } else {
            console.error(`❌ ${view} missing.`);
            passed = false;
        }
    }

    if (passed) {
        console.log('\n✨ KPI Dimensions Proof Complete!');
        process.exit(0);
    } else {
        process.exit(1);
    }
} else {
    console.error('❌ Migration file missing.');
    process.exit(1);
}
