"""Social demo data for `manage.py seed_demo` (DEBUG only).

Forty faculty across eight departments with faces, papers written together
inside and outside the college, follows, feed posts with mentions and
comments, discussion threads, direct messages, a research-office thread and
one finished research-scout run.

Everything that has a side effect in the live app (mentions, notifications,
unread counts) is written through the real API with a signed-in test client,
so the demo shows what the app would really have produced. Publications and
authorships are written directly: in production they come from OpenAlex.

Idempotent: people are keyed by e-mail, papers by DOI, and the posts and
messages are written only once (keyed by the first feed post's text).
"""
from __future__ import annotations

import io
import json
import random
from datetime import timedelta

from django.test import Client
from django.utils import timezone

from core.models import (
    Authorship, FeedPost, Follow, Publication, ResearchInterest, Role, ScoutRun, User,
)

DOMAIN = "college.edu"  # the demo domain; seed.py treats any other address as a live account

# name, department, designation, topics
PEOPLE = [
    ("Dr. Malathi Sundaram", "CSE", "Professor", ["Machine learning", "Medical imaging"]),
    ("Dr. Arvind Krishnan", "CSE", "Associate Professor", ["Computer vision", "Deep learning"]),
    ("Kavya Ramesh", "CSE", "Assistant Professor", ["Natural language processing", "Deep learning"]),
    ("Dr. Sanjay Iyer", "CSE", "Professor", ["Cloud computing", "Edge computing"]),
    ("Divya Lakshmi", "CSE", "Assistant Professor", ["Cyber security", "Blockchain"]),
    ("Dr. Harish Venkatesan", "IT", "Associate Professor", ["Internet of things", "Edge computing"]),
    ("Nandhini Selvam", "IT", "Assistant Professor", ["Information retrieval", "Natural language processing"]),
    ("Dr. Rajesh Kannan", "IT", "Professor", ["Software engineering", "Cloud computing"]),
    ("Pooja Balaji", "IT", "Assistant Professor", ["Blockchain", "Cyber security"]),
    ("Dr. Lakshmi Priya", "AIDS", "Professor", ["Deep learning", "Medical imaging"]),
    ("Vignesh Raman", "AIDS", "Assistant Professor", ["Reinforcement learning", "Robotics"]),
    ("Dr. Shalini Mohan", "AIDS", "Associate Professor", ["Data mining", "Recommender systems"]),
    ("Gokul Prasad", "AIDS", "Assistant Professor", ["Time series forecasting", "Machine learning"]),
    ("Dr. Senthil Kumar", "ECE", "Professor", ["Antenna design", "5G communication"]),
    ("Dr. Revathi Chandran", "ECE", "Associate Professor", ["VLSI design", "Low power circuits"]),
    ("Ashwin Gopal", "ECE", "Assistant Professor", ["Signal processing", "Medical imaging"]),
    ("Dr. Mythili Arun", "ECE", "Professor", ["Wireless sensor networks", "Internet of things"]),
    ("Sneha Vasudevan", "ECE", "Assistant Professor", ["5G communication", "Signal processing"]),
    ("Dr. Balasubramanian R", "EEE", "Professor", ["Power electronics", "Renewable energy"]),
    ("Dr. Anitha Kumari", "EEE", "Associate Professor", ["Smart grid", "Renewable energy"]),
    ("Prakash Murugan", "EEE", "Assistant Professor", ["Electric vehicles", "Power electronics"]),
    ("Dr. Gayathri Devi", "EEE", "Professor", ["Smart grid", "Machine learning"]),
    ("Dr. Ramanathan S", "MECH", "Professor", ["Additive manufacturing", "Composite materials"]),
    ("Dr. Keerthana Raj", "MECH", "Associate Professor", ["Heat transfer", "Renewable energy"]),
    ("Surya Narayanan", "MECH", "Assistant Professor", ["Robotics", "Additive manufacturing"]),
    ("Dr. Vijayalakshmi P", "MECH", "Professor", ["Tribology", "Composite materials"]),
    ("Manoj Kumar", "MECH", "Assistant Professor", ["Computational fluid dynamics", "Heat transfer"]),
    ("Dr. Chitra Sekar", "CIVIL", "Professor", ["Concrete technology", "Sustainable materials"]),
    ("Dr. Aravind Babu", "CIVIL", "Associate Professor", ["Structural health monitoring", "Internet of things"]),
    ("Deepa Natarajan", "CIVIL", "Assistant Professor", ["Water resources", "Remote sensing"]),
    ("Karthikeyan M", "CIVIL", "Assistant Professor", ["Geotechnical engineering", "Sustainable materials"]),
    ("Dr. Padmini Raghavan", "BME", "Professor", ["Biomaterials", "Medical imaging"]),
    ("Dr. Sathish Kumar", "BME", "Associate Professor", ["Biosignal processing", "Signal processing"]),
    ("Harini Suresh", "BME", "Assistant Professor", ["Wearable sensors", "Internet of things"]),
    ("Dr. Suganya Ravi", "CSE", "Associate Professor", ["Federated learning", "Cyber security"]),
    ("Arun Prakash", "ECE", "Assistant Professor", ["Embedded systems", "Wireless sensor networks"]),
    ("Dr. Hemalatha K", "AIDS", "Professor", ["Explainable AI", "Medical imaging"]),
    ("Rohit Shankar", "IT", "Assistant Professor", ["Computer vision", "Robotics"]),
    ("Dr. Uma Maheswari", "EEE", "Associate Professor", ["Battery management", "Electric vehicles"]),
    ("Janani Krishnamurthy", "CIVIL", "Assistant Professor", ["Remote sensing", "Machine learning"]),
]

EXTERNAL = [
    ("Prof. Ravi Shankar", "IIT Madras", "IN"), ("Dr. Wei Chen", "National University of Singapore", "SG"),
    ("Dr. Maria Lopez", "Universidad Politecnica de Madrid", "ES"), ("Prof. Anand Rao", "IISc Bangalore", "IN"),
    ("Dr. Sarah Mitchell", "University of Leeds", "GB"), ("Dr. Kenji Tanaka", "Tohoku University", "JP"),
    ("Prof. Suresh Babu", "Anna University", "IN"), ("Dr. Fatima Al-Sayed", "Khalifa University", "AE"),
    ("Dr. Thomas Weber", "TU Munich", "DE"), ("Prof. Lakshman Reddy", "NIT Tiruchirappalli", "IN"),
    ("Dr. Emily Carter", "University of Toronto", "CA"), ("Dr. Hyun-woo Park", "KAIST", "KR"),
]

VENUES = [
    ("IEEE Access", "Q1"), ("Expert Systems with Applications", "Q1"), ("Scientific Reports", "Q1"),
    ("Sensors", "Q2"), ("Materials Today: Proceedings", ""), ("Journal of Energy Storage", "Q1"),
    ("Biomedical Signal Processing and Control", "Q1"), ("Construction and Building Materials", "Q1"),
    ("Wireless Personal Communications", "Q3"), ("Multimedia Tools and Applications", "Q2"),
]

TITLE_BITS = {
    "Machine learning": "a gradient-boosted model", "Medical imaging": "chest X-ray triage",
    "Computer vision": "lightweight object detection", "Deep learning": "a transformer backbone",
    "Natural language processing": "Tamil text classification", "Cloud computing": "serverless scheduling",
    "Edge computing": "latency-aware offloading", "Cyber security": "intrusion detection",
    "Blockchain": "a permissioned ledger", "Internet of things": "low-power IoT nodes",
    "Information retrieval": "dense passage retrieval", "Software engineering": "test prioritisation",
    "Reinforcement learning": "policy-gradient control", "Robotics": "a mobile manipulator",
    "Data mining": "frequent pattern mining", "Recommender systems": "session-based recommendation",
    "Time series forecasting": "load forecasting", "Antenna design": "a dual-band MIMO antenna",
    "5G communication": "mmWave beam management", "VLSI design": "an approximate multiplier",
    "Low power circuits": "sub-threshold SRAM", "Signal processing": "adaptive filtering",
    "Wireless sensor networks": "energy-aware routing", "Power electronics": "a bidirectional DC-DC converter",
    "Renewable energy": "rooftop solar", "Smart grid": "demand response", "Electric vehicles": "EV charging",
    "Additive manufacturing": "3D-printed lattices", "Composite materials": "natural fibre composites",
    "Heat transfer": "nanofluid cooling", "Tribology": "wear of coated surfaces",
    "Computational fluid dynamics": "CFD of a heat sink", "Concrete technology": "geopolymer concrete",
    "Sustainable materials": "fly-ash bricks", "Structural health monitoring": "bridge vibration sensing",
    "Water resources": "reservoir inflow", "Remote sensing": "Sentinel-2 imagery",
    "Geotechnical engineering": "soil stabilisation", "Biomaterials": "hydroxyapatite scaffolds",
    "Biosignal processing": "ECG arrhythmia detection", "Wearable sensors": "a wrist-worn sensor",
    "Federated learning": "federated training", "Embedded systems": "an RTOS scheduler",
    "Explainable AI": "saliency explanations", "Battery management": "state-of-charge estimation",
}


def email_of(name: str) -> str:
    slug = name.replace("Dr. ", "").replace("Prof. ", "").lower().replace(" ", ".").replace("..", ".")
    return f"{slug}@{DOMAIN}"


def face_png(seed: int) -> bytes:
    """A plain drawn portrait: background, shoulders, face and hair. Not a real person."""
    from PIL import Image, ImageDraw

    r = random.Random(seed)
    bg = r.choice([(214, 228, 240), (232, 222, 206), (220, 236, 222), (238, 224, 232), (226, 226, 240)])
    skin = r.choice([(141, 85, 36), (198, 134, 66), (224, 172, 105), (170, 110, 60), (120, 72, 36)])
    hair = r.choice([(20, 16, 14), (40, 30, 24), (60, 44, 30), (90, 90, 90)])
    shirt = r.choice([(40, 70, 120), (120, 40, 60), (40, 110, 90), (90, 90, 100), (160, 110, 40)])
    img = Image.new("RGB", (256, 256), bg)
    d = ImageDraw.Draw(img)
    d.ellipse((38, 180, 218, 340), fill=shirt)
    d.rectangle((110, 150, 146, 196), fill=skin)
    long_hair = r.random() < 0.5
    if long_hair:
        d.ellipse((66, 48, 190, 210), fill=hair)
    d.ellipse((78, 60, 178, 176), fill=skin)
    d.chord((74, 50, 182, 140), 180, 360, fill=hair)
    d.ellipse((104, 108, 114, 118), fill=(30, 20, 20))
    d.ellipse((142, 108, 152, 118), fill=(30, 20, 20))
    d.arc((112, 132, 144, 154), 20, 160, fill=(90, 40, 40), width=3)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def seed_social(out) -> None:
    rng = random.Random(2026)
    now = timezone.now()

    people: list[User] = []
    for i, (name, dept, desig, topics) in enumerate(PEOPLE):
        u, made = User.objects.get_or_create(
            email=email_of(name),
            defaults=dict(name=name, department=dept, designation=desig, role=Role.FACULTY,
                          bio=f"Works on {topics[0].lower()} and {topics[1].lower()}."),
        )
        if made:
            u.set_unusable_password()
            u.save()
        for t in topics:
            ResearchInterest.objects.get_or_create(user=u, domain=t)
        people.append(u)
    # The pre-existing demo faculty join in so every signed-in demo account has a network.
    old = list(User.objects.filter(role=Role.FACULTY, email__endswith="@college.edu").exclude(pk__in=[p.pk for p in people]))
    for u in old:
        if not u.department:
            u.department = "CSE"
            u.save(update_fields=["department"])
    everyone = people + old
    topics_of = {u.id: PEOPLE[i][3] for i, u in enumerate(people)}
    for u in old:
        topics_of[u.id] = ["Machine learning", "Internet of things"]

    def client(u: User) -> Client:
        c = Client(HTTP_HOST="localhost")
        c.force_login(u)
        return c

    # Faces, for every demo account whatever its role (officers are colleagues too).
    for i, u in enumerate(everyone + list(User.objects.filter(email__endswith="@college.edu").exclude(role=Role.FACULTY))):
        if not u.photo:
            buf = io.BytesIO(face_png(i))
            buf.name = "face.png"
            client(u).post("/api/people/me/photo", {"file": buf})

    # Papers: 2-4 college authors, 0-2 outside authors, shared topics.
    made_papers = 0
    for n in range(90):
        lead = people[n % len(people)]
        lt = topics_of[lead.id]
        partners = [p for p in everyone if p != lead and set(topics_of[p.id]) & set(lt)]
        rng.shuffle(partners)
        team = [lead] + partners[: rng.randint(1, 3)]
        if rng.random() < 0.25:  # a cross-department paper that shares no topic
            team.append(rng.choice(everyone))
        team = list(dict.fromkeys(team))
        topic = rng.choice(lt)
        doi = f"10.5555/demo.social.{n:03d}"
        if Publication.objects.filter(doi=doi).exists():
            continue
        venue, q = rng.choice(VENUES)
        year = rng.choice([2021, 2022, 2023, 2024, 2025, 2025, 2026])
        title = f"{TITLE_BITS.get(topic, topic).capitalize()} for {rng.choice(['rural healthcare', 'smart campuses', 'Indian conditions', 'low-cost deployment', 'real-time use', 'resource-limited settings'])}"
        pub = Publication.objects.create(
            doi=doi, title=title, normalized_title=title.lower(), year=year, venue=venue, quartile=q,
            type="article", citations=rng.choice([0, 1, 2, 4, 7, 11, 15, 23, 38]),
            scopus_indexed=bool(q), source="record", topics_json=json.dumps(list(dict.fromkeys([topic] + lt[:1]))),
        )
        pos = 1
        for u in team:
            Authorship.objects.create(publication=pub, position=pos, display_name=u.name, author_key=f"u:{u.id}",
                                      is_college=True, user=u, match_confidence=1, match_method="demo",
                                      institution_name="Saveetha Engineering College", institution_country="IN")
            pos += 1
        for ext in rng.sample(EXTERNAL, rng.choice([0, 0, 1, 1, 2])):
            Authorship.objects.create(publication=pub, position=pos, display_name=ext[0],
                                      author_key="n:" + ext[0].lower(), institution_name=ext[1],
                                      institution_country=ext[2], raw_affiliation=ext[1])
            pos += 1
        made_papers += 1
    from core.services.publications import refresh_metrics
    # A publication date, so "this academic year" counts something: the
    # leaderboard windows on the date, not the bare year.
    today = now.date()
    for pub in Publication.objects.filter(doi__startswith="10.5555/demo.social.", date__isnull=True):
        d = today.replace(year=pub.year, month=1, day=1) + timedelta(days=rng.randint(0, 364))
        pub.date = min(d, today - timedelta(days=rng.randint(1, 60)))
        pub.save(update_fields=["date"])
    refresh_metrics()

    marker = "Our paper on chest X-ray triage"
    if FeedPost.objects.filter(body__startswith=marker).exists():
        out.write(f"Social demo: {len(people)} people in place, {made_papers} new papers; posts already there.")
        return

    by = {u.name: u for u in everyone}
    meena, arvind, kavya, sanjay = by["Dr. Malathi Sundaram"], by["Dr. Arvind Krishnan"], by["Kavya Ramesh"], by["Dr. Sanjay Iyer"]
    senthil, bala, chitra, padmini = by["Dr. Senthil Kumar"], by["Dr. Balasubramanian R"], by["Dr. Chitra Sekar"], by["Dr. Padmini Raghavan"]

    # Follows.
    for u in everyone:
        for other in rng.sample(everyone, 6):
            if other != u:
                client(u).post(f"/api/follows/people/{other.id}")
        client(u).post("/api/follows/departments", {"department": u.department}, content_type="application/json")

    def post(u, body, mentions=(), **extra):
        r = client(u).post("/api/feed/posts", {"body": body, "mention_ids": [m.id for m in mentions], **extra})
        return r.json().get("id") if r.status_code == 200 else None

    posts = [
        (meena, f'{marker} is out in IEEE Access, with @"{arvind.name}" and @"{padmini.name}". Thanks to the radiology team for the labelled images.', [arvind, padmini]),
        (senthil, "Our dual-band MIMO antenna prototype passed the anechoic chamber tests today. Happy to share the fixture drawings with anyone measuring antennas.", []),
        (kavya, f'Looking for a co-author who has worked on Tamil speech data. @"{nandhini.name}" do you still have the transcribed corpus?' if (nandhini := by["Nandhini Selvam"]) else "", [by["Nandhini Selvam"]]),
        (bala, "Seminar on Thursday 3 pm in the EEE seminar hall: grid-forming inverters for rural microgrids. All departments welcome.", []),
        (chitra, f'Congratulations to @"{by["Deepa Natarajan"].name}" on her first Q1 paper on reservoir inflow forecasting.', [by["Deepa Natarajan"]]),
        (sanjay, "Has anyone here used the college GPU server for federated training? What batch sizes did you get away with?", []),
        (padmini, "Our hydroxyapatite scaffold work was accepted at Materials Today: Proceedings. Four students on the author list.", []),
        (by["Dr. Lakshmi Priya"], f'Reading group on explainable AI for medical imaging starts next week. @"{by["Dr. Hemalatha K"].name}" has kindly agreed to lead the first session.', [by["Dr. Hemalatha K"]]),
        (by["Dr. Ramanathan S"], "We now have a working metal 3D printer in the MECH workshop. Book it through the lab register.", []),
        (by["Harini Suresh"], "Wrist-worn sensor dataset (40 volunteers, 3 weeks) is ready. Write to me if it would help your project.", []),
    ]
    ids = [post(u, body, m) for u, body, m in posts if body]
    for pid in [i for i in ids if i]:
        for u in rng.sample(everyone, 8):
            client(u).post(f"/api/feed/posts/{pid}/reactions/{rng.choice(['LIKE', 'CONGRATS', 'INTERESTED', 'COLLABORATE'])}")
    if ids and ids[0]:
        client(arvind).post(f"/api/feed/posts/{ids[0]}/comments", {"body": "Great teamwork. The second round of review made it much better."}, content_type="application/json")
        client(senthil).post(f"/api/feed/posts/{ids[0]}/comments", {"body": f'Congratulations! @"{meena.name}" could we talk about using it for ultrasound?', "mention_ids": [meena.id]}, content_type="application/json")
    if len(ids) > 2 and ids[2]:
        client(by["Nandhini Selvam"]).post(f"/api/feed/posts/{ids[2]}/comments", {"body": "Yes, about 60 hours. Messaging you now."}, content_type="application/json")

    # Discussion threads (department and public).
    def thread(u, title, body, **extra):
        r = client(u).post("/api/threads", {"title": title, "body": body, **extra}, content_type="application/json")
        return r.json().get("id") if r.status_code == 200 else None

    t1 = thread(sanjay, "Which journals turn papers around in under three months?",
                f'Collecting experiences. @"{by["Dr. Rajesh Kannan"].name}" you published in Expert Systems with Applications last year, how long did it take?')
    if t1:
        client(by["Dr. Rajesh Kannan"]).post(f"/api/threads/{t1}/posts", {"body": "About four months from submission to acceptance, two review rounds."}, content_type="application/json")
        client(kavya).post(f"/api/threads/{t1}/posts", {"body": f'IEEE Access was seven weeks for us. @"{sanjay.name}" happy to share the cover letter.'}, content_type="application/json")
    t2 = thread(by["Dr. Anitha Kumari"], "EEE: shared data for the smart grid project",
                "Uploading the substation load data to the department drive this week. Please do not share it outside.",
                visibility="DEPARTMENT", department="EEE")
    if t2:
        client(by["Dr. Gayathri Devi"]).post(f"/api/threads/{t2}/posts", {"body": "Thank you. Can we get 2024 as well?"}, content_type="application/json")

    # Direct messages and a research-office thread.
    def dm(a, b, first, replies):
        r = client(a).post("/api/dm", {"participant_ids": [b.id], "body": first}, content_type="application/json")
        if r.status_code != 200:
            return
        tid = r.json().get("id") or r.json().get("thread_id")
        for who, text in replies:
            client(who).post(f"/api/dm/{tid}/messages", {"body": text}, content_type="application/json")

    nand = by["Nandhini Selvam"]
    dm(kavya, nand, "Hi Nandhini, saw your note. Could we meet about the Tamil speech corpus?",
       [(nand, "Sure. Tomorrow after 2 pm in the IT lab?"), (kavya, "Perfect, see you then.")])
    dm(senthil, meena, "Your X-ray triage paper is great. Would the model work on ultrasound frames?",
       [(meena, "Possibly, if we fine-tune. Do you have labelled data?")])
    dm(arvind, by["Rohit Shankar"], "Rohit, can you review my object-detection draft before Friday?", [])
    for u in old[:3]:
        dm(u, meena, "Madam, could you suggest a journal for an IoT paper?", [(meena, "Try Sensors or IEEE Internet of Things Journal.")])
    client(kavya).post("/api/threads", {"title": "Why was my paper sent back?", "body": "The note says the affiliation is missing, but it is on page one. Could you look again?", "visibility": "OFFICE"}, content_type="application/json")

    # One finished research-scout run, so the page has something to show.
    if not ScoutRun.objects.filter(user=meena).exists():
        cands = [{"user_id": u.id, "name": u.name, "department": u.department, "papers": 5,
                  "shared_topics": ["Medical imaging"], "their_topics": topics_of[u.id][:2],
                  "why": "Works on the same images from the signal side.", "picked": True}
                 for u in (by["Ashwin Gopal"], by["Dr. Sathish Kumar"], by["Dr. Hemalatha K"])]
        ScoutRun.objects.create(
            user=meena, status=ScoutRun.Status.DONE, finished_at=now,
            result_json=json.dumps({
                "profile": {"name": meena.name, "department": "CSE", "papers": 9, "topics": ["Machine learning", "Medical imaging"]},
                "web": {"summary": "Demo run (seeded, not a real search). Your imaging work lines up with open calls on low-cost diagnostics.",
                        "opportunities": [{"title": "Low-cost diagnostic imaging call (demo)", "kind": "call", "why": "Matches your X-ray triage work.", "deadline": "", "url": ""}],
                        "directions": [{"title": "Ultrasound triage with the same backbone", "builds_on": "Chest X-ray triage", "why": "A colleague in ECE has labelled frames.", "urls": []}],
                        "external_people": []},
                "colleagues": cands, "literature": [], "sources": [], "model": "demo",
                "generated_at": now.isoformat(),
            }),
        )
    Follow.objects.get_or_create(follower=meena, topic="Medical imaging")
    out.write(f"Social demo: {len(people)} people, {made_papers} new papers, posts, threads and messages in place.")




