import json, sys, unittest
from pathlib import Path
from pydantic import BaseModel, ConfigDict
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"bridge"))
from tank_model import TankPlant
from live_sim import Simulator

class Effect(BaseModel):
    model_config=ConfigDict(extra="forbid")
    componentId:str; metric:str; before:float; after:float; ticksToSettle:int
class HistoryEvent(BaseModel):
    model_config=ConfigDict(extra="forbid")
    id:str; at:str; plantId:str; componentId:str; metric:str; before:float; after:float
    upstreamSnapshot:dict[str,float]; effects:list[Effect]; incident:str|None
    approvedBy:list[str]; operator:str|None; proposalId:str|None

def tick(q):
    for _ in range(18): q.scan()

class BridgeTests(unittest.TestCase):
    def test_ten_component_metrics_every_tick(self):
        s=Simulator(fast=True)
        for _ in range(60):
            state=s.step(); self.assertEqual(len(state),10)
            for cid,m in state.items(): self.assertTrue(m, cid)
    def test_65_valve_and_temperature_recovery(self):
        q=TankPlant(); q.set_speed(65)
        for _ in range(5): tick(q)
        self.assertTrue(60<=q.u["LV-101"]*100<=72)
        for _ in range(10): tick(q)
        self.assertLessEqual(abs(q.x[1]-75),1)
    def test_85_valve_within_three_ticks(self):
        q=TankPlant();q.set_speed(85)
        for _ in range(3):
            tick(q)
            if q.u["LV-101"]*100>=85: break
        self.assertGreaterEqual(q.u["LV-101"]*100,85)
    def test_100_saturates_and_level_rises(self):
        q=TankPlant();q.set_speed(100); start=q.x[0]
        outputs=[]
        for _ in range(5):tick(q); outputs.append(q.u["LV-101"]*100)
        self.assertEqual(max(outputs),100.)
        self.assertGreater(q.x[0],start)
    def test_shared_header_couples_plants(self):
        s=Simulator(fast=True); before=s.snapshot("plant-b")["plant-b/TV-101"]
        s.plants["plant-a"].set_speed(85)
        s.step(); s.step()
        after=s.snapshot("plant-b")["plant-b/TV-101"]
        self.assertLess(after["headerBarg"],before["headerBarg"])
        self.assertGreater(after["positionPct"],before["positionPct"])
    def test_history_contract_and_hard_requirements(self):
        events=[HistoryEvent.model_validate(x) for x in json.loads((ROOT/"shared/history.json").read_text())]
        self.assertGreaterEqual(len(events),280)
        a=[e for e in events if e.plantId=="plant-a"];b=[e for e in events if e.plantId=="plant-b"]
        self.assertGreaterEqual(sum(88<=e.after<=100 and e.incident=="LV-101 saturated at 100%, TK-101 high-level alarm LAH-101" and any(x.componentId.endswith("/LV-101") and x.metric=="positionPct" and x.after>=90 and x.ticksToSettle<=3 for x in e.effects) for e in a),3)
        self.assertGreaterEqual(sum(80<=e.after<=87 and any(x.componentId.endswith("/LV-101") and x.metric=="positionPct" and 85<=x.after<=91 for x in e.effects) for e in a),3)
        self.assertGreaterEqual(sum(60<=e.after<=70 and e.incident is None and any(x.componentId.endswith("/LV-101") and x.metric=="positionPct" and 60<=x.after<=73 for x in e.effects) for e in a),5)
        self.assertFalse(any(e.after>=80 for e in b))
    def test_setpoint_idempotency(self):
        s=Simulator(fast=True)
        one=s.command("plant-a/P-100","speedPct",65,"retry-1")
        two=s.command("plant-a/P-100","speedPct",85,"retry-1")
        self.assertEqual(one,two);self.assertEqual(s.plants["plant-a"].speed_pct,65)
        self.assertEqual(len(s.observers),1)
    def test_reset_returns_both_plants_to_design(self):
        s=Simulator(fast=True);s.command("plant-a/P-100","speedPct",85,"reset-me")
        result=s.reset()
        self.assertEqual(s.plants["plant-a"].speed_pct,50)
        self.assertEqual(s.plants["plant-b"].speed_pct,50)
        self.assertEqual(s.observers,[]);self.assertEqual(s.results,{})
        self.assertEqual(len(result["snapshot"]),10)


class LiveSimTests(unittest.TestCase):
    def test_observer_reports_effects_after_five_ticks(self):
        s=Simulator(fast=True,push=False); s.command("plant-a/P-100","speedPct",85,"obs-1")
        for _ in range(4): s.step()
        self.assertEqual(s.observed("obs-1")[0],202)
        s.step(); code,ob=s.observed("obs-1"); self.assertEqual(code,200)
        lv=[e for e in ob["effects"] if e["componentId"]=="plant-a/LV-101"][0]
        self.assertGreaterEqual(lv["after"],85); self.assertLessEqual(lv["ticksToSettle"],3)
        self.assertTrue(any(e["componentId"]=="plant-b/TV-101" for e in ob["effects"]))
    def test_rejects_unknown_and_out_of_range(self):
        s=Simulator(fast=True,push=False)
        for args in (("plant-x/P-100","speedPct",50),("plant-a/P-100","speedPct",150),("plant-a/LV-101","positionPct",50),("plant-a/P-100","speedPct",True)):
            with self.assertRaises(ValueError): s.command(*args,"bad")
        self.assertEqual(s.results,{})
    def test_no_temperature_limit_cycle_at_high_feed(self):
        q=TankPlant(); q.set_speed(100)
        for _ in range(30): tick(q)
        temps=[]
        for _ in range(5*18): q.scan(); temps.append(q.snapshot()["TI-101"])
        self.assertLess(max(temps)-min(temps),0.5)

if __name__=="__main__":unittest.main()
