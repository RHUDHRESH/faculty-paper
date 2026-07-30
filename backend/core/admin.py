from django.contrib import admin
from . import models

admin.site.register(models.User)
admin.site.register(models.Claim)
admin.site.register(models.FormulaConfig)
admin.site.register(models.MonthlyBatch)
admin.site.register(models.MonthlyRow)
admin.site.register(models.ScimagoJournal)
