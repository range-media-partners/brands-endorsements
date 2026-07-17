import os
from functools import wraps
from flask import Flask, request, session, redirect, url_for, render_template, jsonify

from data import get_talent_data

app = Flask(__name__)
app.secret_key = os.environ["FLASK_SECRET_KEY"]
DASHBOARD_PASSWORD = os.environ["DASHBOARD_PASSWORD"]


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if request.form.get("password") == DASHBOARD_PASSWORD:
            session["authenticated"] = True
            return redirect(request.args.get("next") or url_for("index"))
        error = "Incorrect password"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/api/data")
@login_required
def api_data():
    return jsonify(get_talent_data())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))