import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from parser import parse_green_button_xml
from datetime import datetime, date, timedelta

from recovery import EXPECTED_XML_FILENAME, render_recovery_screen
from sample_data import load_sample_dataframe
from vampire import estimate_base_load_kw, infer_interval_hours, monthly_vampire_cost

# Set page config
st.set_page_config(page_title="Electricity Usage Dashboard", layout="wide")

st.title("⚡ Home Electricity Usage Insights")
st.markdown("Understanding your Oakville Hydro energy data.")

@st.cache_data
def load_data():
    file_path = EXPECTED_XML_FILENAME
    df = parse_green_button_xml(file_path)
    return df

@st.cache_data
def load_sample_data():
    return load_sample_dataframe()

# --- Data loading, with a friendly recovery path when the XML is missing ---
# The real export is gitignored (size + personal energy data), so a fresh clone
# has no file: explain the situation and offer the bundled sample data instead of
# a dead-end "Error loading data: [Errno 2] ..." box.
load_error = None
df = None

if st.session_state.get("use_sample_data", False):
    # User already opted into the bundled sample data this session.
    df = load_sample_data()
else:
    try:
        df = load_data()
    except Exception as exc:
        load_error = exc
        df = None

    if df is not None and df.empty:
        load_error = ValueError(f"{EXPECTED_XML_FILENAME} contains no IntervalReading rows")
        df = None

if df is None:
    if render_recovery_screen(load_error):
        # Set the flag and re-run so the recovery screen itself is not shown
        # above the dashboard that the sample data just unlocked.
        st.session_state["use_sample_data"] = True
        st.rerun()
    st.stop()

if st.session_state.get("use_sample_data", False):
    sample_banner, real_file_button = st.columns([5, 1])
    sample_banner.info(
        "🧛 **Bundled sample data in use** - synthetic 5-day readings, not your household."
    )
    if real_file_button.button("↩️ Use my real file", key="back_to_real_data"):
        st.session_state["use_sample_data"] = False
        st.rerun()

# Sidebar: TOU Rates & Vacation
st.sidebar.header("Configuration")

# Standard Ontario TOU Rates (Cents per kWh) - Approx values
off_peak_rate = st.sidebar.number_input("Off-Peak Rate (cents/kWh)", value=8.7)
mid_peak_rate = st.sidebar.number_input("Mid-Peak Rate (cents/kWh)", value=12.2)
on_peak_rate = st.sidebar.number_input("On-Peak Rate (cents/kWh)", value=18.2)

st.sidebar.markdown("---")
st.sidebar.header("Vacation Mode")
vacation_dates = st.sidebar.date_input(
    "Select dates you were away:",
    value=[],
    help="Isolate usage when the house was empty to see your true 'vampire' base load."
)

# TOU Classification Logic
def classify_tou(row):
    dt = row['datetime']
    # Weekends are always Off-Peak
    if dt.weekday() >= 5:
        return 'Off-Peak'
    
    hour = dt.hour
    month = dt.month
    
    # Winter (Nov 1 - Apr 30)
    if month <= 4 or month >= 11:
        if 7 <= hour < 11 or 17 <= hour < 19:
            return 'On-Peak'
        elif 11 <= hour < 17:
            return 'Mid-Peak'
        else:
            return 'Off-Peak'
    # Summer (May 1 - Oct 31)
    else:
        if 11 <= hour < 17:
            return 'On-Peak'
        elif 7 <= hour < 11 or 17 <= hour < 19:
            return 'Mid-Peak'
        else:
            return 'Off-Peak'

df['tou_category'] = df.apply(classify_tou, axis=1)

# Calculate costs
rate_map = {
    'Off-Peak': off_peak_rate / 100.0,
    'Mid-Peak': mid_peak_rate / 100.0,
    'On-Peak': on_peak_rate / 100.0
}
df['cost'] = df.apply(lambda row: row['usage_kwh'] * rate_map[row['tou_category']], axis=1)

# --- KPI Section ---
col1, col2, col3, col4 = st.columns(4)

total_usage = df['usage_kwh'].sum()
total_cost = df['cost'].sum()
avg_daily_usage = df.groupby('date')['usage_kwh'].sum().mean()

# Base Load Calculation
# Robust proxy: P05 of usage over the trailing 90 days (vampire.py).
# The old argmin latched onto a single outage dip / lucky quiet reading and
# treated it as the 24/7 floor; a trailing percentile shrugs those outliers off.
# usage_kwh is per reading interval, and Green Button / ESPI exports arrive
# hourly, half-hourly or 15-minute -- so the P05 only equals kW on an hourly
# feed. vampire.py divides out the interval it measures from the data itself;
# here we surface that interval so the unit behind the dollar figure is visible.
interval_hours = infer_interval_hours(df)
base_load_kw = estimate_base_load_kw(df)
vampire_monthly_cost = monthly_vampire_cost(base_load_kw, off_peak_rate) # Conservative estimate at off-peak

interval_label = (
    f"{interval_hours:g}-hour reading interval"
    if interval_hours >= 1
    else f"{interval_hours * 60:g}-minute reading interval"
)

col1.metric("Total Usage", f"{total_usage:,.1f} kWh")
col2.metric("Total Est. Cost", f"${total_cost:,.2f}")
col3.metric("Avg Daily Usage", f"{avg_daily_usage:.1f} kWh")
col4.metric(
    "Vampire Draw Cost",
    f"${vampire_monthly_cost:.2f}/mo",
    help=(
        "Estimated always-on cost: 5th-percentile usage over the trailing 90 days, "
        f"converted from your {interval_label} to kW, x 24 h x 30.4 days, at your "
        "off-peak rate."
    ),
)

st.markdown("---")

# --- Layout: Charts ---
tab1, tab2, tab3 = st.tabs(["📊 Usage Trends", "🧛 Vampire & Vacation", "💰 Savings Potential"])

with tab1:
    st.subheader("Daily Usage Over Time")
    daily_usage = df.groupby('date')['usage_kwh'].sum().reset_index()
    fig_daily = px.line(daily_usage, x='date', y='usage_kwh', title="Daily kWh Consumption")
    st.plotly_chart(fig_daily, use_container_width=True)

    col_a, col_b = st.columns(2)
    
    with col_a:
        st.subheader("Daily Routine (Hourly Average)")
        # usage_kwh is energy PER READING INTERVAL (exports arrive 15-, 30- or
        # 60-minute), so average per DATE-HOUR first: summing an hour's readings
        # and then averaging those hour totals is numerically identical for
        # hourly data -- the demo does not move -- and stops reading 4x too low
        # on a 15-minute export.
        hourly_avg = (
            df.groupby(['date', 'hour'])['usage_kwh']
            .sum()
            .groupby('hour')
            .mean()
            .reset_index()
        )
        fig_hourly = px.bar(hourly_avg, x='hour', y='usage_kwh', 
                            labels={'usage_kwh': 'Avg kWh', 'hour': 'Hour of Day'},
                            title="Average Usage by Hour")
        st.plotly_chart(fig_hourly, use_container_width=True)

    with col_b:
        st.subheader("Top 5 Highest Usage Days")
        top_days = daily_usage.sort_values('usage_kwh', ascending=False).head(5)
        st.table(top_days)

with tab2:
    st.subheader("Identifying Your 'Always-On' Load")
    st.write("The 'Vampire Draw' is the electricity consumed by devices that are never truly off (fridges, standby electronics, smart home hubs).")
    
    if len(vacation_dates) == 2:
        start_vac, end_vac = vacation_dates
        vacation_df = df[(df['date'] >= start_vac) & (df['date'] <= end_vac)]
        
        if not vacation_df.empty:
            st.success(f"Analyzing Vacation Period: {start_vac} to {end_vac}")
            # Per DATE-HOUR first (same reasoning as the Daily Routine chart):
            # the mean of an hour's readings, then averaged over the days you
            # were away. Identical for hourly exports, 4x right for 15-minute.
            vac_avg_hourly = (
                vacation_df.groupby(['date', 'hour'])['usage_kwh'].sum().mean()
            )
            st.metric("Avg Vacation Hourly Usage", f"{vac_avg_hourly:.3f} kWh")
            
            fig_vac = px.line(vacation_df, x='datetime', y='usage_kwh', title="Usage While Away")
            st.plotly_chart(fig_vac, use_container_width=True)
        else:
            st.warning("No data found for the selected vacation dates.")
    else:
        st.info("💡 Select a date range in the sidebar when you were away to see your house's baseline usage.")

    st.subheader("Weekend vs. Weekday Comparison")
    wkend_comparison = df.groupby('is_weekend')['usage_kwh'].mean().reset_index()
    wkend_comparison['day_type'] = wkend_comparison['is_weekend'].map({True: 'Weekend', False: 'Weekday'})
    fig_wkend = px.bar(wkend_comparison, x='day_type', y='usage_kwh', title="Average Daily Consumption")
    st.plotly_chart(fig_wkend, use_container_width=True)

with tab3:
    st.subheader("Time-of-Use Breakdown")
    col_c, col_d = st.columns(2)
    
    tou_usage = df.groupby('tou_category')['usage_kwh'].sum().reset_index()
    tou_cost = df.groupby('tou_category')['cost'].sum().reset_index()
    
    with col_c:
        fig_pie_usage = px.pie(tou_usage, values='usage_kwh', names='tou_category', title="% of Total kWh")
        st.plotly_chart(fig_pie_usage, use_container_width=True)
        
    with col_d:
        fig_pie_cost = px.pie(tou_cost, values='cost', names='tou_category', title="% of Total Cost")
        st.plotly_chart(fig_pie_cost, use_container_width=True)

    st.markdown("---")
    st.subheader("💰 'What If' Savings Calculator")
    shift_percent = st.slider("If I shifted this % of On-Peak usage to Off-Peak:", 0, 100, 10)
    
    on_peak_total_kwh = df[df['tou_category'] == 'On-Peak']['usage_kwh'].sum()
    kwh_to_shift = on_peak_total_kwh * (shift_percent / 100.0)
    
    # Savings calculation
    savings = kwh_to_shift * (on_peak_rate - off_peak_rate) / 100.0
    
    st.write(f"By shifting **{kwh_to_shift:,.1f} kWh** (the equivalent of laundry or dishwashers) from On-Peak to Off-Peak, you would have saved:")
    st.title(f"${savings:,.2f}")
    st.write("*(Note: This is based on your entire data history since Jan 2024)*")

st.markdown("---")
st.caption("Data source: Oakville Hydro Green Button Export. All costs are estimates and do not include fixed delivery charges, regulatory charges, or HST.")
